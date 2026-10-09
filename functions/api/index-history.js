// ============================================================
// CF Pages Function: /api/index-history?months=3&until=2026-10-09
// 日経平均（株探コード 0000）と TOPIX（0010）の日足の終値を、指定した月数ぶん返す。
// 動画の「指数」の場面のチャート用。AI は使わない（取得＋パースのみ）。
// ・株探の日足ページは1ページ約30営業日。月数から必要なページ数を決めて並列で取る
// ・行は <th scope="row"><time datetime=…> のものだけ読む（ページ内の別の表の日付を拾わない）
// ============================================================

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const CODES = { nikkei: "0000", topix: "0010" };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
}

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return await r.text();
}

function parseRows(html) {
  const rows = [];
  for (const tr of html.split("<tr")) {
    const d = tr.match(/<th scope="row"><time datetime="(\d{4}-\d{2}-\d{2})"/);
    if (!d) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").replace(/,/g, "").trim());
    if (tds.length < 4) continue;
    const close = parseFloat(tds[3]);   // 始値・高値・安値・終値
    if (isFinite(close)) rows.push({ date: d[1], close });
  }
  return rows;
}

async function series(code, pages, since, until) {
  const htmls = await Promise.all(Array.from({ length: pages }, (_, i) =>
    fetchHtml(`https://kabutan.jp/stock/kabuka?code=${code}&ashi=day&page=${i + 1}`).catch(() => "")));
  const byDate = new Map();
  for (const h of htmls) for (const r of parseRows(h)) if (!byDate.has(r.date)) byDate.set(r.date, r.close);
  return [...byDate.entries()].filter(([d]) => d >= since && d <= until).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const months = Math.min(24, Math.max(1, parseInt(url.searchParams.get("months") || "3", 10) || 3));
  // until（動画の対象日）から months か月さかのぼる。無ければ今日（日本時間）
  const todayStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const untilStr = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("until") || "") ? url.searchParams.get("until") : todayStr;
  const since = new Date(untilStr + "T00:00:00Z");
  since.setUTCMonth(since.getUTCMonth() - months);
  const sinceStr = since.toISOString().slice(0, 10);
  // 株探は新しい日から1ページ約30営業日。今日から since までの営業日（≒暦日×5/7）ぶん取る
  const days = (Date.parse(todayStr) - Date.parse(sinceStr)) / 86400000;
  const pages = Math.min(24, Math.ceil((days * 5) / 7 / 30) + 1);
  try {
    const [nikkei, topix] = await Promise.all([series(CODES.nikkei, pages, sinceStr, untilStr), series(CODES.topix, pages, sinceStr, untilStr)]);
    if (!nikkei.length && !topix.length) return json({ ok: false, error: "株探から指数の値を取得できませんでした" });
    return json({ ok: true, months, since: sinceStr, until: untilStr, nikkei, topix, source: "株探（日足）" });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}
