/**
 * 作業内容の保存先（Cloudflare R2。別の端末で続きから開くため。2026-10-18）
 *
 *   GET  /api/state                  … 保存してある日の一覧（新しい順。date, rev, updatedAt, baseDate）
 *   GET  /api/state?date=D           … その日の目録（manifest）
 *   GET  /api/state?date=D&part=N    … 目録が指す中身の1つ（各欄の文章のまとめ・画像・音声など）
 *   PUT  /api/state?date=D&part=N    … 中身の1つを置く（N は中身から作った名前。同じ中身なら同じ名前）
 *   PUT  /api/state?date=D           … 目録を置く。rev で上書き事故を防ぐ（別の端末が先に置いていたら 409）。
 *                                      前の作業より中身が半分以下に減るときも、allowShrink が無ければ置かない（409・shrink。2026-11-14）。
 *                                      置いたあと、目録にも残している前の版にも無い中身と、新しい順で KEEP_DAYS 日より前の日を消す。
 *   GET  /api/state?date=D&history=1 … その日の前の版の一覧（新しい順。rev, updatedAt, amount, baseDate, reason, pin）
 *   GET  /api/state?date=D&rev=N     … 前の版の目録（中身は part= で取れる）
 *   PUT  /api/state?date=D&restore=N … 前の版 N を今の版にする（今の版も前の版として残す）
 *
 * 前の版（2026-11-16。11/13 の作業が 16 日の作業で上書きされて消えた件）：上書きするとき、前の目録を h/<日付>/<rev>.json に残し、
 * その中身も消さずに残す。1日ごとに新しい順で KEEP_GENS 世代。30分ごとに1世代（続けて保存しても世代を使い切らない）。
 * 基準日が変わる・日が変わる・別の端末からの上書き（force）・中身が大きく減る上書き（allowShrink）・前の版に戻す、のときは
 * 30分たっていなくても残し、これは KEEP_GENS とは別に KEEP_PINNED 世代まで残す（ふつうの保存で押し出されないように）。
 * データ取得をしたとき（画面が mark:'fetch' を付けて保存する）は、その前の版を残し、取得の直後の版も上書きされるときに必ず残す。
 * 取得の直後の版は KEEP_FETCH 世代まで別に残す（過去の日のデータは取り直せないため。2026-11-16）。
 *
 * 保存先はアカウントごと（2026-11-16。R2 の u/<アカウント>/ の下。functions/_shared/store.js）。書けるのは自分の保存先だけ。
 * GET に from=<アカウント>（分ける前の共有は from=_shared）を付けると、ほかの保存を読める（読むだけ）。
 *   GET  /api/state?owners=1         … 保存のあるアカウントごとの日の一覧（自分が先頭、共有が最後）
 *
 * 1日＝目録1つ（m/<日付>.json）＋中身いくつか（p/<日付>/<名前>）。画面側（index.html の ssgSync〜）が、
 * 変わった中身だけを置いてから目録を置く。
 * R2 が紐づいていない（env.STATE が無い）ときは 503 を返し、画面側はブラウザ保存だけで動く。
 * 使えるのは、ログイン（Cloudflare Access）を通った本番の画面と、ローカルの確認だけ（gemini-key.js と同じ）。
 */

import { pick, owners } from '../_shared/store.js';

const PROD_HOST = 'ssg-9506afd114d7.pages.dev';
const KEEP_DAYS = 10;  // 残す日数（保存はプロンプトをコピーした日だけできるので、だいたい直近10営業日）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PART_RE = /^[0-9a-f]{32,64}$/;
const KEEP_GENS = 5;        // 前の版を残す数（1日ごと）
const KEEP_PINNED = 3;      // 基準日・日が変わったときなどの前の版を、別に残す数
const KEEP_FETCH = 5;       // データ取得の直後の版を、別に残す数（過去の日のデータは取り直せないため。2026-11-16）
const GEN_MIN_MS = 30 * 60 * 1000;   // ふつうの保存で前の版を残す間隔
const jstDay = iso => { const d = new Date(iso); return isNaN(d) ? '' : new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };

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

// 前の版の一覧（新しい順）
async function gens(bucket, date) {
  const objs = await listAll(bucket, `h/${date}/`, ['customMetadata']);
  return objs.map(o => {
    const m = o.customMetadata || {};
    return { key: o.key, rev: Number(m.rev) || 0, updatedAt: m.updatedAt || '', savedAt: m.savedAt || o.uploaded.toISOString(), amount: Number(m.amount) || 0, baseDate: m.baseDate || '', reason: m.reason || '', pin: m.pin === '1' };
  }).filter(g => g.rev > 0).sort((a, b) => b.rev - a.rev);
}
const manRefs = m => { const out = [m.ls]; for (const rows of Object.values(m.idb || {})) for (const r of (Array.isArray(rows) ? rows : [])) out.push(r && r.part); return out.filter(Boolean); };
// 今の版 cur を前の版として残すか（残すときは理由）
function genReason(cur, next, list) {
  if (cur.mark === 'fetch') return 'fetch';          // データ取得の直後の版（取り直せないので必ず残す）
  if (next.mark === 'fetch') return 'beforeFetch';   // データ取得の前の版
  if (next.restore) return 'restore';
  if (next.force) return 'force';
  if (next.allowShrink) return 'shrink';
  if ((cur.baseDate || '') !== (next.baseDate || '')) return 'baseDate';
  if (jstDay(cur.updatedAt) !== jstDay(new Date().toISOString())) return 'day';
  const last = list[0];
  if (!last) return 'first';
  if (new Date(cur.updatedAt) - new Date(last.updatedAt) >= GEN_MIN_MS) return 'time';
  return '';
}
// cur を前の版に残し、世代を数で切り、どの版からも指されない中身を消す
async function rotate(bucket, date, cur, next, newRefs) {
  let list = await gens(bucket, date);
  if (cur) {
    const reason = genReason(cur, next, list);
    if (reason && !list.some(g => g.rev === Number(cur.rev))) {
      const pin = !['time', 'first'].includes(reason);
      await bucket.put(`h/${date}/${cur.rev}.json`, JSON.stringify(cur), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { rev: String(cur.rev), updatedAt: cur.updatedAt || '', savedAt: new Date().toISOString(), amount: String(cur.amount ?? ''), baseDate: cur.baseDate || '', reason, pin: pin ? '1' : '0' },
      });
      list = await gens(bucket, date);
    }
  }
  const keepGen = new Set(list.slice(0, KEEP_GENS).map(g => g.key));
  for (const g of list.filter(g => g.reason === 'fetch' && !keepGen.has(g.key)).slice(0, KEEP_FETCH)) keepGen.add(g.key);
  for (const g of list.filter(g => g.pin && g.reason !== 'fetch' && !keepGen.has(g.key)).slice(0, KEEP_PINNED)) keepGen.add(g.key);
  const drop = list.filter(g => !keepGen.has(g.key)).map(g => g.key);
  if (drop.length) await bucket.delete(drop);
  const keep = new Set(newRefs.map(n => `p/${date}/${n}`));
  for (const g of list.filter(g => keepGen.has(g.key))) {
    try { const o = await bucket.get(g.key); if (o) for (const n of manRefs(await o.json())) keep.add(`p/${date}/${n}`); }
    catch (e) { return; }   // 前の版を読めないときは、中身を消さない
  }
  await delPrefix(bucket, `p/${date}/`, keep);
}

// 作業の量（2026-11-14）：中身のある欄（50字以上）の数＋画像・音声などの数（BGM は数えない）。
// 空から始めた端末や、読み込み中に押したボタンで中身が減った端末が、前の作業を上書きしないように比べる
const MIN_FIELD = 50;
async function amount(bucket, date, lsName, idb) {
  let n = 0;
  try {
    const o = await bucket.get(`p/${date}/${lsName}`);
    const ls = o ? JSON.parse(await o.text()) : {};
    for (const v of Object.values(ls || {})) if (typeof v === 'string' && v.trim().length >= MIN_FIELD) n++;
  } catch (e) {}
  for (const [name, rows] of Object.entries(idb || {})) if (name !== 'ssg-bgm' && Array.isArray(rows)) n += rows.length;
  return n;
}

export async function onRequestGet(context) {
  const g = guard(context); if (g) return g;
  const sc = pick(context, false); if (sc.error) return json({ ok: false, error: sc.error }, 403);
  const bucket = sc.bucket;
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date');
  const part = url.searchParams.get('part');
  try {
    if (url.searchParams.get('owners')) return json({ ok: true, me: sc.me, owners: await owners(context.env.STATE, sc.me, days) });
    if (!date) return json({ ok: true, days: await days(bucket), keep: KEEP_DAYS, owner: sc.owner, me: sc.me });
    if (!DATE_RE.test(date)) return json({ ok: false, error: '日付の形が違います' }, 400);
    if (url.searchParams.get('history')) {
      return json({ ok: true, history: (await gens(bucket, date)).map(({ key, ...g }) => g), keep: KEEP_GENS });
    }
    if (url.searchParams.get('rev')) {
      const rev = Number(url.searchParams.get('rev'));
      if (!Number.isInteger(rev) || rev <= 0) return json({ ok: false, error: '版の形が違います' }, 400);
      const o = await bucket.get(`h/${date}/${rev}.json`);
      if (!o) return json({ ok: false, error: 'その版は残っていません' }, 404);
      return json({ ok: true, manifest: await o.json() });
    }
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
  const sc = pick(context, true); if (sc.error) return json({ ok: false, error: sc.error }, 403);
  const bucket = sc.bucket;
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date');
  const part = url.searchParams.get('part');
  if (!date || !DATE_RE.test(date)) return json({ ok: false, error: '日付の形が違います' }, 400);
  try {
    if (url.searchParams.get('restore')) {
      // 前の版 N を今の版にする（今の版は前の版として残す）
      const rev = Number(url.searchParams.get('restore'));
      if (!Number.isInteger(rev) || rev <= 0) return json({ ok: false, error: '版の形が違います' }, 400);
      const ho = await bucket.get(`h/${date}/${rev}.json`);
      if (!ho) return json({ ok: false, error: 'その版は残っていません' }, 404);
      const old = await ho.json();
      const curObj = await bucket.get(`m/${date}.json`);
      const cur = curObj ? await curObj.json() : null;
      const now = new Date().toISOString();
      const manifest = Object.assign({}, old, { rev: (cur ? Number(cur.rev) || 0 : 0) + 1, updatedAt: now, restoredFrom: rev });
      await bucket.put(`m/${date}.json`, JSON.stringify(manifest), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { rev: String(manifest.rev), updatedAt: now, baseDate: manifest.baseDate || '', amount: String(manifest.amount ?? '') },
      });
      await rotate(bucket, date, cur, { restore: true, baseDate: manifest.baseDate }, manRefs(manifest));
      return json({ ok: true, rev: manifest.rev, updatedAt: now });
    }
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

    // 前の作業より大きく減る（半分以下になる）保存は、allowShrink（画面で「上書きする」を選んだとき）が無ければ上書きしない。
    // 前の作業はサーバーにそのまま残る（2026-11-14 すみぽん「空からスタートになったら上書きせず、前をサーバーに残す」）
    const newAmount = await amount(bucket, date, body.ls, body.idb);
    // 中身が何も無い作業は保存しない（2026-11-14）
    if (newAmount === 0) return json({ ok: false, empty: true, error: '中身が無いので保存しません' }, 422);
    if (cur && !body.allowShrink) {
      const curAmount = Number.isFinite(Number(cur.amount)) ? Number(cur.amount) : await amount(bucket, date, cur.ls, cur.idb);
      if (curAmount > 0 && newAmount <= Math.floor(curAmount / 2)) {
        return json({ ok: false, shrink: true, curAmount, newAmount, rev: have, updatedAt: cur.updatedAt }, 409);
      }
    }
    const now = new Date().toISOString();
    const manifest = { v: 1, date, mark: body.mark === 'fetch' ? 'fetch' : '', amount: newAmount, rev: have + 1, updatedAt: now, baseDate: String(body.baseDate || ''), step: String(body.step || ''), ls: body.ls, idb: body.idb };
    await bucket.put(`m/${date}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { rev: String(manifest.rev), updatedAt: now, baseDate: manifest.baseDate, amount: String(newAmount) },
    });
    // 前の目録を前の版として残し（2026-11-16）、今の版にも前の版にも無い中身を消す
    await rotate(bucket, date, cur, { force: !!body.force, allowShrink: !!body.allowShrink, baseDate: manifest.baseDate, mark: manifest.mark }, refs);
    // 新しい順で KEEP_DAYS 日より前の日を消す
    const all = await days(bucket);
    for (const d of all.slice(KEEP_DAYS)) {
      await bucket.delete(`m/${d.date}.json`);
      await delPrefix(bucket, `p/${d.date}/`);
      await delPrefix(bucket, `h/${d.date}/`);
    }
    return json({ ok: true, rev: manifest.rev, updatedAt: now });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
