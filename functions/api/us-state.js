// ============================================================
// /api/us-state（2026-11-14）：米国版の作業をサーバー（R2）に保存する。別の端末・別の日でも続きから開ける
//   GET  /api/us-state                     … 保存してある日の一覧（新しい順。date, rev, updatedAt）
//   GET  /api/us-state?date=D              … その日の作業（{ ok, doc, rev, updatedAt }）
//   PUT  /api/us-state?date=D              … その日の作業を置く（本文 { doc, baseRev, force }）。別の端末が先に置いていたら 409
//   GET  /api/us-state?date=D&audio=K      … 動画の読み上げの音声（場面ごと。中身は音声そのもの、text・seconds・speed は見出しに）
//   PUT  /api/us-state?date=D&audio=K      … 音声を置く（見出し X-Text（URL エンコード）・X-Seconds・X-Speed）
// 置き場所：us/<日付>/state.json、us/<日付>/audio/<キー>。日付は米国の対象日。新しい順で KEEP_DAYS 日より前は消す。
// 東証版の保存（/api/state。m/・p/）とは別。使えるのは、ログイン（Cloudflare Access）を通った本番の画面とローカルだけ。
// ============================================================

const PROD_HOST = "ssg-9506afd114d7.pages.dev";
const KEEP_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIO_RE = /^[A-Za-z0-9:_\-]{1,64}$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function guard(context) {
  const { request, env } = context;
  const host = new URL(request.url).hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local && (host !== PROD_HOST || !request.headers.get("Cf-Access-Jwt-Assertion"))) return json({ ok: false, error: "このURLでは使えません", denied: true }, 403);
  if (!env.STATE) return json({ ok: false, error: "R2（STATE）が紐づいていません", notReady: true }, 503);
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
  const objs = (await listAll(bucket, "us/", ["customMetadata"])).filter((o) => /^us\/\d{4}-\d{2}-\d{2}\/state\.json$/.test(o.key));
  return objs.map((o) => ({ date: o.key.slice(3, 13), rev: Number((o.customMetadata || {}).rev) || 0, updatedAt: (o.customMetadata || {}).updatedAt || o.uploaded.toISOString() }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function onRequestGet(context) {
  const g = guard(context); if (g) return g;
  const bucket = context.env.STATE;
  const url = new URL(context.request.url);
  const date = url.searchParams.get("date"), audio = url.searchParams.get("audio");
  try {
    if (!date) return json({ ok: true, days: await days(bucket), keep: KEEP_DAYS });
    if (!DATE_RE.test(date)) return json({ ok: false, error: "日付の形が違います" }, 400);
    if (audio) {
      if (!AUDIO_RE.test(audio)) return json({ ok: false, error: "名前の形が違います" }, 400);
      const o = await bucket.get(`us/${date}/audio/${audio}`);
      if (!o) return json({ ok: false, error: "その音声はありません" }, 404);
      const m = o.customMetadata || {};
      return new Response(o.body, { headers: { "content-type": (o.httpMetadata && o.httpMetadata.contentType) || "audio/wav", "cache-control": "no-store", "x-text": m.text || "", "x-seconds": m.seconds || "", "x-speed": m.speed || "" } });
    }
    const o = await bucket.get(`us/${date}/state.json`);
    if (!o) return json({ ok: false, error: "その日の保存はありません" }, 404);
    const s = await o.json();
    return json({ ok: true, doc: s.doc, rev: s.rev, updatedAt: s.updatedAt });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}

export async function onRequestPut(context) {
  const g = guard(context); if (g) return g;
  const { request, env } = context;
  const bucket = env.STATE;
  const url = new URL(request.url);
  const date = url.searchParams.get("date"), audio = url.searchParams.get("audio");
  if (!date || !DATE_RE.test(date)) return json({ ok: false, error: "日付の形が違います" }, 400);
  try {
    if (audio) {
      if (!AUDIO_RE.test(audio)) return json({ ok: false, error: "名前の形が違います" }, 400);
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 20 * 1024 * 1024) return json({ ok: false, error: "音声が大きすぎます" }, 413);
      await bucket.put(`us/${date}/audio/${audio}`, buf, {
        httpMetadata: { contentType: request.headers.get("content-type") || "audio/wav" },
        customMetadata: { text: (request.headers.get("x-text") || "").slice(0, 1800), seconds: request.headers.get("x-seconds") || "", speed: request.headers.get("x-speed") || "" },
      });
      return json({ ok: true });
    }
    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: "内容を読み取れませんでした" }, 400); }
    if (!body || typeof body.doc !== "object" || !body.doc) return json({ ok: false, error: "作業の形が違います" }, 400);
    const curObj = await bucket.get(`us/${date}/state.json`);
    const cur = curObj ? await curObj.json() : null;
    const have = cur ? Number(cur.rev) || 0 : 0;
    if (!body.force && have !== (Number(body.baseRev) || 0)) return json({ ok: false, conflict: true, rev: have, updatedAt: cur && cur.updatedAt }, 409);
    const now = new Date().toISOString();
    const rev = have + 1;
    await bucket.put(`us/${date}/state.json`, JSON.stringify({ v: 1, date, rev, updatedAt: now, doc: body.doc }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { rev: String(rev), updatedAt: now },
    });
    // 作業の中の音声の一覧に無くなった音声を消す
    const keepAudio = new Set(Object.keys((body.doc && body.doc.audio) || {}).map((k) => `us/${date}/audio/${k}`));
    const olds = (await listAll(bucket, `us/${date}/audio/`)).map((o) => o.key).filter((k) => !keepAudio.has(k));
    if (olds.length) await bucket.delete(olds);
    // 新しい順で KEEP_DAYS 日より前の日を消す
    for (const d of (await days(bucket)).slice(KEEP_DAYS)) {
      const keys = (await listAll(bucket, `us/${d.date}/`)).map((o) => o.key);
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    }
    return json({ ok: true, rev, updatedAt: now });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
