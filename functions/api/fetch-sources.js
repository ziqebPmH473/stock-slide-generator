// ============================================================
// CF Pages Function: /api/fetch-sources
// 野村・株探・日経の8URLをサーバー側で取得し、構造化データにパースする。
// ・各ソースを表パースして rows（構造化）にする（指数・寄与度・業種・日経ランキング）
// ・同時に生テキスト text も保持（AIバックアップ用：構造変更で rows が壊れても拾える）
// ・Gemini API は使わない（取得＋パースのみ）
// ============================================================

const SOURCES = [
  { key: "nomura_index",         label: "野村：指数",       url: "https://quote.nomura.co.jp/nomura/cgi-bin/quote.cgi?template=nomura_tp_index_01" },
  { key: "kabutan_contrib_desc", label: "株探：寄与度(高)", url: "https://s.kabutan.jp/warnings/nk225_contrib/?direction=desc&order=contrib_price" },
  { key: "kabutan_contrib_asc",  label: "株探：寄与度(低)", url: "https://s.kabutan.jp/warnings/nk225_contrib/?direction=asc&order=contrib_price" },
  { key: "nikkei_rise",          label: "日経：上昇率",     url: "https://www.nikkei.com/marketdata/ranking-jp/price-rise/?market=G_TP" },
  { key: "nikkei_drop",          label: "日経：下落率",     url: "https://www.nikkei.com/marketdata/ranking-jp/price-drop/?market=G_TP" },
  { key: "kabutan_sector_desc",  label: "株探：業種別(高)", url: "https://s.kabutan.jp/warnings/sector_stocks_ranking/" },
  { key: "kabutan_sector_asc",   label: "株探：業種別(低)", url: "https://s.kabutan.jp/warnings/sector_stocks_ranking/?direction=asc&order=prev_price_ratio" },
  { key: "nikkei_value",         label: "日経：売買代金",   url: "https://www.nikkei.com/marketdata/ranking-jp/trading-value/?market=all" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function cellText(c) {
  return c.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --- 野村：指数 ---
function parseNomuraIndex(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellText).filter(Boolean);
    if (cells.length < 3) continue;
    const [name, val, chg] = cells;
    if (!/円|ポイント/.test(val) || !/%/.test(chg)) continue;   // 指数行のみ
    const value = val.replace(/円|ポイント/g, "").trim();
    const cm = chg.match(/([+\-][\d.,]+)\s*\(([+\-][\d.]+)\s*%\)/);
    rows.push({ name, value, change: cm ? cm[1] : "", pct: cm ? cm[2] + "%" : "" });
  }
  return rows;
}

// --- 野村：各市場の出来高・時価総額 ---
function parseNomuraVolume(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellText).filter(Boolean);
    if (cells.length < 3) continue;
    if (!/^東証(プライム|スタンダード|グロース)$/.test(cells[0])) continue;
    if (!/株/.test(cells[1]) || !/円/.test(cells[2])) continue;
    rows.push({ market: cells[0], volume: cells[1], mcap: cells[2] });
  }
  return rows;
}

// --- 株探：寄与度（コード＋銘柄名＋株価＋寄与度）---
function parseKabutanContrib(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const codeM = tr.match(/\/stocks\/(\d{3}[0-9A-Za-z])\//);
    if (!codeM) continue;
    const nameM = tr.match(/<p[^>]*font-bold[^>]*>([^<]+)<\/p>/);
    const tds = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cellText);
    if (tds.length < 2) continue;
    const contrib = tds[1];
    if (!/[+\-][\d.]/.test(contrib)) continue;
    rows.push({ code: codeM[1], name: nameM ? nameM[1].trim() : "", price: tds[0], contrib });
  }
  return rows;
}

// --- 株探：業種別（業種名＋変動率＋PER）---
function parseKabutanSector(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const nameM = tr.match(/<p[^>]*font-bold[^>]*>([^<]+)<\/p>/);
    if (!nameM) continue;
    const tds = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cellText);
    if (tds.length < 4) continue;
    const nums = (tds[2] || "").match(/[+\-][\d.]+/g) || [];
    const rate = nums.length ? nums[nums.length - 1] + "%" : "";
    const per = (tds[3] || "").replace(/[^\d.]/g, "");
    rows.push({ name: nameM[1].trim(), rate, per: per ? per + "倍" : "" });
  }
  return rows;
}

// --- 日経：__NEXT_DATA__ のランキング ---
function parseNikkei(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const list = data && data.props && data.props.pageProps && data.props.pageProps.data && data.props.pageProps.data.data_lists;
  if (!Array.isArray(list)) return null;
  return list.map((r) => ({
    rank: r.RANK ?? "", code: r.BICD ?? "", name: r.SOBA_NAME ?? "", industry: r.NGYO_NAME ?? "",
    rate: r.AYRP ?? "", price: r.DPP ?? "", change: r.AYWP ?? "", value: r.DJ ?? "",
  }));
}

async function fetchOne(src) {
  const out = { key: src.key, label: src.label, url: src.url };
  try {
    const res = await fetch(src.url, {
      headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "ja,en;q=0.9" },
      redirect: "follow", cf: { cacheTtl: 0 },
    });
    out.status = res.status;
    const html = await res.text();
    out.bytes = html.length;
    const httpOk = res.status >= 200 && res.status < 300;
    // 生テキスト（AIバックアップ用）
    out.text = htmlToText(html).slice(0, 12000);
    // 構造化パース
    if (src.key === "nomura_index") { out.kind = "index"; out.rows = parseNomuraIndex(html); out.volumes = parseNomuraVolume(html); }
    else if (src.key.startsWith("kabutan_contrib")) { out.kind = "contrib"; out.rows = parseKabutanContrib(html); }
    else if (src.key.startsWith("kabutan_sector")) { out.kind = "sector"; out.rows = parseKabutanSector(html); }
    else if (src.key.startsWith("nikkei_")) { out.kind = "ranking"; out.rows = parseNikkei(html) || []; }
    const rc = out.rows ? out.rows.length : 0;
    if (rc) out.rowCount = rc;
    // ページは200でも中身が取れていなければエラー扱いにする
    let dataOk = true, reason = "";
    if (!httpOk) { dataOk = false; reason = `HTTP ${res.status}`; }
    else if (src.key === "nomura_index") {
      const names = (out.rows || []).map((r) => r.name);
      if (!(names.includes("日経平均") && names.includes("TOPIX"))) { dataOk = false; reason = "指数（日経平均/TOPIX）が取得できていません"; }
    } else if (src.key.startsWith("kabutan_contrib")) {
      if (rc < 5) { dataOk = false; reason = `寄与度データが不足（${rc}件）`; }
    } else if (src.key.startsWith("kabutan_sector")) {
      if (rc < 5) { dataOk = false; reason = `業種データが不足（${rc}件）`; }
    } else if (src.key.startsWith("nikkei_")) {
      if (rc < 5) { dataOk = false; reason = `ランキングデータが不足（${rc}件）`; }
    }
    out.ok = dataOk;
    if (!dataOk) out.reason = reason;
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

export async function onRequest(context) {
  const results = await Promise.all(SOURCES.map(fetchOne));
  return new Response(JSON.stringify({ fetchedAt: new Date().toISOString(), sources: results }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
