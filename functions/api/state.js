/**
 * 作業内容の保存先（Cloudflare R2。別の端末で続きから開くため。2026-10-18）
 *
 *   GET  /api/state                  … 保存してある日の一覧（新しい順。date, rev, updatedAt, baseDate）
 *   GET  /api/state?date=D           … その日の目録（manifest）
 *   GET  /api/state?date=D&part=N    … 目録が指す中身の1つ（各欄の文章のまとめ・画像・音声など）
 *   PUT  /api/state?date=D&part=N    … 中身の1つを置く（N は中身から作った名前。同じ中身なら同じ名前）
 *   PUT  /api/state?date=D           … 目録を置く。rev で上書き事故を防ぐ（別の端末が先に置いていたら 409）。
 *                                      置いたあと、目録に無い中身と、新しい順で KEEP_DAYS 日より前の日を消す。
 *
 * 1日＝目録1つ（m/<日付>.json）＋中身いくつか（p/<日付>/<名前>）。画面側（index.html の ssgSync〜）が、
 * 変わった中身だけを置いてから目録を置く。
 * R2 が紐づいていない（env.STATE が無い）ときは 503 を返し、画面側はブラウザ保存だけで動く。
 * 使えるのは、ログイン（Cloudflare Access）を通った本番の画面と、ローカルの確認だけ（gemini-key.js と同じ）。
 */

const PROD_HOST = 'ssg-9506afd114d7.pages.dev';
const KEEP_DAYS = 5;   // 残す日数（保存はプロンプトをコピーした日だけできるので、だいたい直近5営業日）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PART_RE = /^[0-9a-f]{32,64}$/;

function allowed(request) {
  const host = new URL(request.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return host === PROD_HOST && !!request.headers.get('Cf-Access-Jwt-Assertion');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function guard(context) {
  if (!allowed(context.request)) return json({ ok: false, error: 'このURLでは使えません', denied: true }, 403);
  if (!context.env.STATE) return json({ ok: false, error: 'R2（STATE）が紐づいていません（ブラウザ保存だけで動きます）', notReady: true }, 503);
  return null;
}
async function listAll(bucket, prefix, include) {
  const out = [];
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor, include });
    out.push(...r.objects);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}
async function days(bucket) {
  const objs = await listAll(bucket, 'm/', ['customMetadata']);
  return objs.map(o => {
    const m = o.customMetadata || {};
    return { date: o.key.slice(2, 12), rev: Number(m.rev) || 0, updatedAt: m.updatedAt || o.uploaded.toISOString(), baseDate: m.baseDate || '' };
  }).filter(d => DATE_RE.test(d.date)).sort((a, b) => b.date.localeCompare(a.date));
}
async function delPrefix(bucket, prefix, keep) {
  const objs = await listAll(bucket, prefix);
  const keys = objs.map(o => o.key).filter(k => !keep || !keep.has(k));
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

export async function onRequestGet(context) {
  const g = guard(context); if (g) return g;
  const bucket = context.env.STATE;
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date');
  const part = url.searchParams.get('part');
  try {
    if (!date) return json({ ok: true, days: await days(bucket), keep: KEEP_DAYS });
    if (!DATE_RE.test(date)) return json({ ok: false, error: '日付の形が違います' }, 400);
    if (part) {
      if (!PART_RE.test(part)) return json({ ok: false, error: '名前の形が違います' }, 400);
      const o = await bucket.get(`p/${date}/${part}`);
      if (!o) return json({ ok: false, error: 'その中身はありません' }, 404);
      return new Response(o.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const o = await bucket.get(`m/${date}.json`);
    if (!o) return json({ ok: false, error: 'その日の保存はありません' }, 404);
    return json({ ok: true, manifest: await o.json() });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPut(context) {
  const g = guard(context); if (g) return g;
  const bucket = context.env.STATE;
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date');
  const part = url.searchParams.get('part');
  if (!date || !DATE_RE.test(date)) return json({ ok: false, error: '日付の形が違います' }, 400);
  try {
    if (part) {
      if (!PART_RE.test(part)) return json({ ok: false, error: '名前の形が違います' }, 400);
      await bucket.put(`p/${date}/${part}`, await context.request.arrayBuffer(), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }
    let body;
    try { body = await context.request.json(); } catch (e) { return json({ ok: false, error: '内容を読み取れませんでした' }, 400); }
    if (!body || typeof body.ls !== 'string' || !body.idb || typeof body.idb !== 'object') return json({ ok: false, error: '目録の形が違います' }, 400);

    // 別の端末が先に置いていたら、上書きせずに知らせる（force のときは上書き）
    const curObj = await bucket.get(`m/${date}.json`);
    const cur = curObj ? await curObj.json() : null;
    const have = cur ? Number(cur.rev) || 0 : 0;
    if (!body.force && have !== (Number(body.baseRev) || 0)) {
      return json({ ok: false, conflict: true, rev: have, updatedAt: cur && cur.updatedAt }, 409);
    }
    // 目録が指す中身がそろっているか（置き忘れのまま目録だけ進むと、別の端末で開けなくなる）
    const refs = [body.ls];
    for (const rows of Object.values(body.idb)) for (const r of (Array.isArray(rows) ? rows : [])) refs.push(r && r.part);
    if (refs.some(n => !PART_RE.test(String(n || '')))) return json({ ok: false, error: '目録の名前の形が違います' }, 400);
    const exist = new Set((await listAll(bucket, `p/${date}/`)).map(o => o.key));
    const missing = [...new Set(refs)].filter(n => !exist.has(`p/${date}/${n}`));
    if (missing.length) return json({ ok: false, missing }, 422);

    const now = new Date().toISOString();
    const manifest = { v: 1, date, rev: have + 1, updatedAt: now, baseDate: String(body.baseDate || ''), step: String(body.step || ''), ls: body.ls, idb: body.idb };
    await bucket.put(`m/${date}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { rev: String(manifest.rev), updatedAt: now, baseDate: manifest.baseDate },
    });
    // 目録に無くなった中身を消す
    await delPrefix(bucket, `p/${date}/`, new Set(refs.map(n => `p/${date}/${n}`)));
    // 新しい順で KEEP_DAYS 日より前の日を消す
    const all = await days(bucket);
    for (const d of all.slice(KEEP_DAYS)) {
      await bucket.delete(`m/${d.date}.json`);
      await delPrefix(bucket, `p/${d.date}/`);
    }
    return json({ ok: true, rev: manifest.rev, updatedAt: now });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
