// ============================================================
// /api/us-state（2026-11-14）：米国版の作業をサーバー（R2）に保存する。別の端末・別の日でも続きから開ける
//   GET  /api/us-state                     … 保存してある日の一覧（新しい順。date, rev, updatedAt）
//   GET  /api/us-state?date=D              … その日の作業（{ ok, doc, rev, updatedAt }）
//   PUT  /api/us-state?date=D              … その日の作業を置く（本文 { doc, baseRev, force, allowShrink }）。別の端末が先に置いていたら 409。
//                                            前の作業より中身が半分以下に減るときも、allowShrink が無ければ置かない（409・shrink。2026-11-14）
//   GET  /api/us-state?date=D&audio=K      … 動画の読み上げの音声（場面ごと。中身は音声そのもの、text・seconds・speed は見出しに）
//   PUT  /api/us-state?date=D&audio=K      … 音声を置く（見出し X-Text（URL エンコード）・X-Seconds・X-Speed）
//   GET  /api/us-state?date=D&history=1    … 前の版の一覧（新しい順）。GET ?date=D&rev=N … 前の版の作業
//   PUT  /api/us-state?date=D&restore=N    … 前の版 N を今の版にする（今の版も前の版として残す）
// 前の版（2026-11-16）：上書きするとき前の作業を us/<日付>/hist/<rev>.json に残す。決まりは東証版（/api/state）と同じ
//   （1日ごとに新しい順で5世代・30分ごとに1世代。基準日の変わり目などは別に3世代）。音声は場面ごとに上書きされるので、前の版には入らない。
// 置き場所：us/<日付>/state.json、us/<日付>/audio/<キー>。日付は米国の対象日。新しい順で KEEP_DAYS 日より前は消す。
// 東証版の保存（/api/state。m/・p/）とは別。使えるのは、ログイン（Cloudflare Access）を通った本番の画面とローカルだけ。
// ============================================================

import { pick, owners } from "../_shared/store.js";

const PROD_HOST = "ssg-9506afd114d7.pages.dev";
const KEEP_DAYS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIO_RE = /^[A-Za-z0-9:_\-]{1,64}$/;
const KEEP_GENS = 5, KEEP_PINNED = 3, KEEP_FETCH = 5, GEN_MIN_MS = 30 * 60 * 1000;   // KEEP_FETCH：データ取得の直後の版（2026-11-16）
const jstDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10); };
async function gens(bucket, date) {
  const objs = await listAll(bucket, `us/${date}/hist/`, ["customMetadata"]);
  return objs.map((o) => { const m = o.customMetadata || {}; return { key: o.key, rev: Number(m.rev) || 0, updatedAt: m.updatedAt || "", savedAt: m.savedAt || o.uploaded.toISOString(), amount: Number(m.amount) || 0, reason: m.reason || "", pin: m.pin === "1" }; })
    .filter((g) => g.rev > 0).sort((a, b) => b.rev - a.rev);
}
async function rotate(bucket, date, cur, next) {
  let list = await gens(bucket, date);
  if (cur) {
    let reason = cur.mark === "fetch" ? "fetch" : next.mark === "fetch" ? "beforeFetch" : next.restore ? "restore" : next.force ? "force" : next.allowShrink ? "shrink" : jstDay(cur.updatedAt) !== jstDay(new Date().toISOString()) ? "day" : "";
    if (!reason) reason = !list[0] ? "first" : (new Date(cur.updatedAt) - new Date(list[0].updatedAt) >= GEN_MIN_MS ? "time" : "");
    if (reason && !list.some((g) => g.rev === Number(cur.rev))) {
      await bucket.put(`us/${date}/hist/${cur.rev}.json`, JSON.stringify(cur), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { rev: String(cur.rev), updatedAt: cur.updatedAt || "", savedAt: new Date().toISOString(), amount: String(amount(cur.doc)), reason, pin: ["time", "first"].includes(reason) ? "0" : "1" },
      });
      list = await gens(bucket, date);
    }
  }
  const keep = new Set(list.slice(0, KEEP_GENS).map((g) => g.key));
  for (const g of list.filter((g) => g.reason === "fetch" && !keep.has(g.key)).slice(0, KEEP_FETCH)) keep.add(g.key);
  for (const g of list.filter((g) => g.pin && g.reason !== "fetch" && !keep.has(g.key)).slice(0, KEEP_PINNED)) keep.add(g.key);
  const drop = list.filter((g) => !keep.has(g.key)).map((g) => g.key);
  if (drop.length) await bucket.delete(drop);
}

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
  const sc = pick(context, false); if (sc.error) return json({ ok: false, error: sc.error }, 403);
  const bucket = sc.bucket;
  const url = new URL(context.request.url);
  const date = url.searchParams.get("date"), audio = url.searchParams.get("audio");
  try {
    if (url.searchParams.get("owners")) return json({ ok: true, me: sc.me, owners: await owners(context.env.STATE, sc.me, days) });
    if (!date) return json({ ok: true, days: await days(bucket), keep: KEEP_DAYS, owner: sc.owner, me: sc.me });
    if (!DATE_RE.test(date)) return json({ ok: false, error: "日付の形が違います" }, 400);
    if (url.searchParams.get("history")) return json({ ok: true, history: (await gens(bucket, date)).map(({ key, ...g }) => g), keep: KEEP_GENS });
    if (url.searchParams.get("rev")) {
      const o = await bucket.get(`us/${date}/hist/${Number(url.searchParams.get("rev")) || 0}.json`);
      if (!o) return json({ ok: false, error: "その版は残っていません" }, 404);
      const s = await o.json();
      return json({ ok: true, doc: s.doc, rev: s.rev, updatedAt: s.updatedAt });
    }
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

// 作業の量（2026-11-14）：中身のある項目（50字以上）の数＋動画のデータ＋読み上げの数。前の作業より大きく減る保存は上書きしない
function amount(doc) {
  let n = 0;
  const st = (doc && doc.state) || {};
  for (const v of Object.values(st)) { const t = typeof v === "string" ? v : JSON.stringify(v ?? ""); if (t && t.trim().length >= 50) n++; }
  if (doc && doc.video) n++;
  n += Object.keys((doc && doc.audio) || {}).length;
  return n;
}

export async function onRequestPut(context) {
  const g = guard(context); if (g) return g;
  const { request, env } = context;
  const sc = pick(context, true); if (sc.error) return json({ ok: false, error: sc.error }, 403);
  const bucket = sc.bucket;
  const url = new URL(request.url);
  const date = url.searchParams.get("date"), audio = url.searchParams.get("audio");
  if (!date || !DATE_RE.test(date)) return json({ ok: false, error: "日付の形が違います" }, 400);
  try {
    if (url.searchParams.get("restore")) {
      const rev = Number(url.searchParams.get("restore"));
      const ho = await bucket.get(`us/${date}/hist/${rev}.json`);
      if (!rev || !ho) return json({ ok: false, error: "その版は残っていません" }, 404);
      const old = await ho.json();
      const curObj = await bucket.get(`us/${date}/state.json`);
      const cur = curObj ? await curObj.json() : null;
      const now = new Date().toISOString();
      const nrev = (cur ? Number(cur.rev) || 0 : 0) + 1;
      await bucket.put(`us/${date}/state.json`, JSON.stringify({ v: 1, date, rev: nrev, updatedAt: now, doc: old.doc, restoredFrom: rev }), { httpMetadata: { contentType: "application/json" }, customMetadata: { rev: String(nrev), updatedAt: now } });
      await rotate(bucket, date, cur, { restore: true });
      return json({ ok: true, rev: nrev, updatedAt: now });
    }
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
    // 中身が何も無い作業は保存しない（2026-11-14）
    if (amount(body.doc) === 0) return json({ ok: false, empty: true, error: "中身が無いので保存しません" }, 422);
    const curObj = await bucket.get(`us/${date}/state.json`);
    const cur = curObj ? await curObj.json() : null;
    const have = cur ? Number(cur.rev) || 0 : 0;
    if (!body.force && have !== (Number(body.baseRev) || 0)) return json({ ok: false, conflict: true, rev: have, updatedAt: cur && cur.updatedAt }, 409);
    // 前の作業より大きく減る（半分以下になる）保存は、allowShrink が無ければ上書きしない（前の作業はサーバーに残る）
    if (cur && !body.allowShrink) {
      const curAmount = amount(cur.doc), newAmount = amount(body.doc);
      if (curAmount > 0 && newAmount <= Math.floor(curAmount / 2)) return json({ ok: false, shrink: true, curAmount, newAmount, rev: have, updatedAt: cur.updatedAt }, 409);
    }
    const now = new Date().toISOString();
    const rev = have + 1;
    await bucket.put(`us/${date}/state.json`, JSON.stringify({ v: 1, date, rev, updatedAt: now, mark: body.mark === "fetch" ? "fetch" : "", doc: body.doc }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { rev: String(rev), updatedAt: now },
    });
    await rotate(bucket, date, cur, { force: !!body.force, allowShrink: !!body.allowShrink, mark: body.mark === "fetch" ? "fetch" : "" });   // 前の作業を前の版に残す（2026-11-16）
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
