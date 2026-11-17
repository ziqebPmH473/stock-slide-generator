// ============================================================
// CF Pages Function: /api/meigara-dict（2026-11-17 すみぽん「東証の銘柄一覧、ブラウザーごとじゃなくサーバー保存に。アカウントごとじゃなくていい」）
// 東証 data_j から取り込んだ銘柄一覧（コード → 銘柄名）を、全アカウント共通の1つとして R2 に置く。
// ・GET：{ ok, dict, meta }。まだ無ければ { ok:true, none:true }
// ・PUT：{ dict, meta } を受け取って置き換える（1000件未満は受け付けない）
// ・R2 のキーは common/meigara-dict.json（アカウントの保存先 u/<アカウント>/ の外）
// ・R2（STATE）が紐づいていないときは 503（画面はブラウザの保存だけで動く）
// ============================================================

const KEY = "common/meigara-dict.json";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ env }) {
  if (!env.STATE) return json({ ok: false, error: "R2（STATE）が紐づいていません", notReady: true }, 503);
  const o = await env.STATE.get(KEY);
  if (!o) return json({ ok: true, none: true });
  try {
    const d = JSON.parse(await o.text());
    return json({ ok: true, dict: d.dict || {}, meta: d.meta || null });
  } catch (e) {
    return json({ ok: false, error: "保存した銘柄一覧を読めませんでした" }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  if (!env.STATE) return json({ ok: false, error: "R2（STATE）が紐づいていません", notReady: true }, 503);
  let p;
  try { p = await request.json(); } catch (e) { return json({ ok: false, error: "中身が JSON ではありません" }, 400); }
  const src = p && typeof p.dict === "object" && p.dict ? p.dict : null;
  if (!src) return json({ ok: false, error: "銘柄一覧（dict）がありません" }, 400);
  const dict = {};
  let count = 0;
  for (const [k, v] of Object.entries(src)) {
    const code = String(k).trim().slice(0, 10), name = String(v || "").trim().slice(0, 100);
    if (!code || !name) continue;
    dict[code] = name; count++;
  }
  if (count < 1000) return json({ ok: false, error: `銘柄が少なすぎます（${count}件）` }, 400);
  const m = (p && p.meta) || {};
  const meta = { source: String(m.source || "").slice(0, 40), date: String(m.date || "").slice(0, 20), count, savedAt: new Date().toISOString() };
  await env.STATE.put(KEY, JSON.stringify({ dict, meta }), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, meta });
}
