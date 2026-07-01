// ============================================================
// CF Pages Function: /api/fetch-sources
// 野村・株探・日経の8URLをサーバー側で取得して返す。
// ・CORS/文字コードの問題をサーバー側で吸収する
// ・日経は __NEXT_DATA__ の構造化JSONを解析して行データにする
// ・株探/野村は HTML からテキストを抽出して返す
// この段階では Gemini API は使わない（取得の検証用）。
// ============================================================

const SOURCES = [
  { key: "nomura_index",   label: "野村：指数",          url: "https://quote.nomura.co.jp/nomura/cgi-bin/quote.cgi?template=nomura_tp_index_01" },
  { key: "kabutan_contrib_desc", label: "株探：寄与度(高)", url: "https://s.kabutan.jp/warnings/nk225_contrib/?direction=desc&order=contrib_price" },
  { key: "kabutan_contrib_asc",  label: "株探：寄与度(低)", url: "https://s.kabutan.jp/warnings/nk225_contrib/?direction=asc&order=contrib_price" },
  { key: "nikkei_rise",    label: "日経：上昇率",        url: "https://www.nikkei.com/marketdata/ranking-jp/price-rise/?market=G_TP" },
  { key: "nikkei_drop",    label: "日経：下落率",        url: "https://www.nikkei.com/marketdata/ranking-jp/price-drop/?market=G_TP" },
  { key: "kabutan_sector_desc", label: "株探：業種別(高)", url: "https://s.kabutan.jp/warnings/sector_stocks_ranking/" },
  { key: "kabutan_sector_asc",  label: "株探：業種別(低)", url: "https://s.kabutan.jp/warnings/sector_stocks_ranking/?direction=asc&order=prev_price_ratio" },
  { key: "nikkei_value",   label: "日経：売買代金",      url: "https://www.nikkei.com/marketdata/ranking-jp/trading-value/?market=all" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// HTML → プレーンテキスト（script/style除去・タグ除去・空白圧縮）
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

// 日経の __NEXT_DATA__ からランキング行を抽出
function parseNikkei(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const list = data?.props?.pageProps?.data?.data_lists;
  if (!Array.isArray(list)) return null;
  return list.map((r) => ({
    rank:     r.RANK ?? "",
    code:     r.BICD ?? "",
    name:     r.SOBA_NAME ?? "",
    industry: r.NGYO_NAME ?? "",
    rate:     r.AYRP ?? "",       // 変動率(%)
    price:    r.DPP ?? "",        // 株価
    change:   r.AYWP ?? "",       // 前日比
    value:    r.DJ ?? "",         // 売買代金
  }));
}

async function fetchOne(src) {
  const out = { key: src.key, label: src.label, url: src.url };
  try {
    const res = await fetch(src.url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en;q=0.9",
      },
      redirect: "follow",
      cf: { cacheTtl: 0 },
    });
    out.status = res.status;
    const html = await res.text();
    out.bytes = html.length;

    if (src.key.startsWith("nikkei_")) {
      const rows = parseNikkei(html);
      if (rows && rows.length) {
        out.type = "rows";
        out.rows = rows;
      } else {
        out.type = "text";
        out.text = htmlToText(html).slice(0, 8000);
        out.warn = "日経JSONの解析に失敗（フォールバックでテキスト抽出）";
      }
    } else {
      out.type = "text";
      out.text = htmlToText(html).slice(0, 12000);
    }
    out.ok = res.status >= 200 && res.status < 300;
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

export async function onRequest(context) {
  const results = await Promise.all(SOURCES.map(fetchOne));
  const body = JSON.stringify({ fetchedAt: new Date().toISOString(), sources: results });
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
