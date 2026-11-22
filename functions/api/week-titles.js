// ============================================================
// CF Pages Function: /api/week-titles（2026-11-22 すみぽん「週間まとめの見出しをツール側で変えられるように。端末が変わっても残るように」）
// 週間まとめの表紙の見出し（場面ごと）を、全アカウント共通の1つとして R2 に置く。
// ・GET：{ ok, titles:{ index, contrib, sectors, rise, fall, trading }, savedAt }。まだ無ければ { ok:true, none:true }
// ・PUT：{ titles } を受け取って置き換える（空の場面は既定の見出しに戻す＝保存しない）
// ・R2 のキーは common/week-titles.json（アカウントの保存先 u/<アカウント>/ の外。meigara-dict.js と同じ置き方）
// ・R2（STATE）が紐づいていないときは 503（画面は既定の見出しで動く）
// ============================================================

const KEY = "common/week-titles.json";
const IDS = ["index", "contrib", "sectors", "rise", "fall", "trading"];

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
    return json({ ok: true, titles: d.titles || {}, savedAt: d.savedAt || "" });
  } catch (e) {
    return json({ ok: false, error: "保存した見出しを読めませんでした" }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  if (!env.STATE) return json({ ok: false, error: "R2（STATE）が紐づいていません", notReady: true }, 503);
  let p;
  try { p = await request.json(); } catch (e) { return json({ ok: false, error: "中身が JSON ではありません" }, 400); }
  const src = p && typeof p.titles === "object" && p.titles ? p.titles : null;
  if (!src) return json({ ok: false, error: "見出し（titles）がありません" }, 400);
  const titles = {};
  for (const id of IDS) {
    const v = String(src[id] ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 30);
    if (v) titles[id] = v;
  }
  const savedAt = new Date().toISOString();
  await env.STATE.put(KEY, JSON.stringify({ titles, savedAt }), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, titles, savedAt });
}
