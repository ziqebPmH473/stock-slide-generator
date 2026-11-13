// ============================================================
// CF Pages Function: /api/us-sources?part=markets|earnings|movers （米国版の取得。2026-11-14）
// 米国市場の振り返り（全自動版）の数字をツールが取る。AI は使わない（取得＋計算のみ）。
// 方針は docs/design/2026-11-13_米国版（全自動）の方針.md
//
// part=markets  … 指数・先物・為替・金・ビットコイン・原油・米10年債（Yahoo の日足。取れなければ日経の API）
//                  ＋大阪の日経先物（日経の API。取れなければ CME を Yahoo から）＋3指数のチャート用の日足
// part=earnings … 決算の一覧（Finnhub の予想・実績＋Nasdaq の時価総額・発表の時間）。
//                  銘柄ごとに Yahoo の5分足（時間外つき）から当日の値動きと時間外の値動きを出し、天気を計算する
// part=movers   … 変動率の高い銘柄（Yahoo のスクリーナー：値上がり・値下がり・売買の多い）。場面には出さない
// part を付けなければ3つとも返す（Cloudflare の外への取得の回数の上限があるので、画面からは part ごとに呼ぶ）
//
// 共通の引数：date=YYYY-MM-DD（対象日＝米国の営業日。無ければ「直近で取引が終わった日」）
// earnings の引数：must=AAPL,MSFT（必ず載せる銘柄）、mcap=10（時価総額の下限・十億ドル）、max=16（載せる数）
//                  eu=3&ed=-1&su=1&sd=-0.5（天気の幅：EPS の晴れ／雨、売上の晴れ／雨。％）
// movers の引数：mcap=2（時価総額の下限・十億ドル）
// ============================================================

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const YH = "https://query1.finance.yahoo.com";

// 場面1〜4に出すもの。nk は日経の API での種類とコード（Yahoo が取れないときの予備）
export const MARKETS = [
  { key: "dji",    name: "NYダウ",        symbol: "^DJI",    scene: 1, chart: true, nk: ["indexes", "DJI"] },
  { key: "spx",    name: "S&P500",        symbol: "^GSPC",   scene: 1, chart: true, nk: ["indexes", "SPX"] },
  { key: "ixic",   name: "ナスダック",    symbol: "^IXIC",   scene: 1, chart: true, nk: ["indexes", "IXIC"] },
  { key: "sox",    name: "SOX指数",       symbol: "^SOX",    scene: 2, nk: ["indexes", "SOX"] },
  { key: "rut",    name: "ラッセル2000",  symbol: "^RUT",    scene: 2 },
  { key: "vix",    name: "VIX指数",       symbol: "^VIX",    scene: 2, nk: ["indexes", "VIX"] },
  { key: "usdjpy", name: "ドル円",        symbol: "JPY=X",   scene: 3, nk: ["currencies", "USDJPY"] },
  { key: "us10y",  name: "米10年債利回り", symbol: "^TNX",   scene: 4, unit: "%", nk: ["financial_bonds_market", "US10YT"] },
  { key: "gold",   name: "金",            symbol: "GC=F",    scene: 4, unit: "ドル" },
  { key: "btc",    name: "ビットコイン",  symbol: "BTC-USD", scene: 4, unit: "ドル" },
  { key: "wti",    name: "原油（WTI）",   symbol: "CL=F",    scene: 4, unit: "ドル", nk: ["commodities_futures", "CLC1"] },
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
}
const errMsg = (e) => String(e && e.message ? e.message : e);
const num = (v) => (v === null || v === undefined || v === "" || !isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,*/*", ...headers }, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url.replace(/token=[^&]+/, "token=***")}`);
  return await r.json();
}

// 秒 → その取引所の日付（YYYY-MM-DD。夏時間も含めて正しく出す）
const tzDate = (sec, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York" }).format(new Date(sec * 1000));
// 秒 → 日本時間の「11/14 6:55」
function jstLabel(sec) {
  const d = new Date((sec + 9 * 3600) * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ---------- Yahoo の日足 ----------
async function yahooDaily(symbol, range = "6mo") {
  const d = await getJson(`${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`);
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw new Error(`Yahoo に ${symbol} の日足がありません`);
  const meta = r.meta, q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    const c = num(q.close[i]);
    if (c !== null) bars.push({ date: tzDate(t, meta.exchangeTimezoneName), t, close: c });
  });
  // 同じ日付が2本あるとき（取引中の最新値が別に付く）は後のほうを使う
  const byDate = new Map();
  for (const b of bars) byDate.set(b.date, b);
  return { meta, bars: [...byDate.values()] };
}

// 対象日（米国の営業日）を決める。S&P500 の日足のうち、取引が終わった最後の日
function decideTargetDate(spx, wanted) {
  const { meta, bars } = spx;
  const dates = bars.map((b) => b.date);
  if (wanted) {
    const i = dates.lastIndexOf(dates.filter((d) => d <= wanted).pop());
    if (i < 0) throw new Error(`${wanted} 以前の取引日がありません`);
    return { target: dates[i], prev: dates[i - 1] || null, inSession: false };
  }
  const now = Date.now() / 1000;
  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  let i = dates.length - 1;
  // 取引中（寄り付き〜引け）なら、最後の1本はまだ終わっていないので1つ前の日にする
  const inSession = !!(reg && now >= reg.start && now < reg.end && dates[i] === tzDate(reg.start, meta.exchangeTimezoneName));
  if (inSession) i -= 1;
  return { target: dates[i], prev: dates[i - 1] || null, inSession };
}

// 日足から対象日の値と前日比
function pickDay(bars, target) {
  let i = -1;
  for (let k = 0; k < bars.length; k++) if (bars[k].date <= target) i = k;
  if (i < 1) return null;
  const cur = bars[i], prev = bars[i - 1];
  return { date: cur.date, value: cur.close, prevClose: prev.close, prevDate: prev.date, change: cur.close - prev.close, pct: ((cur.close - prev.close) / prev.close) * 100 };
}

// ---------- 日経の API ----------
async function nikkeiValues(pairs) {
  const groups = {};
  for (const [kind, code] of pairs) (groups[kind] = groups[kind] || []).push(code);
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.join(",")]))).toString();
  const d = await getJson(`https://www.nikkei.com/marketdata/api/global-overview/indicatorValue/?${qs}`);
  // 返りは quickapi のコード（N101/T など）なので、indicator_code に戻す
  const back = Object.fromEntries(Object.entries(NK_QUOTE).map(([k, v]) => [v, k]));
  const out = {};
  for (const kind of Object.keys(groups)) for (const row of d[kind] || []) if (back[row.code]) out[back[row.code]] = row;
  return out;
}
// 日経の indicator_code → 返りの code（日経の「世界の市況」ページに埋め込まれている対応。2026-11-14 に確認）
const NK_QUOTE = {
  NK225: "N101/T", JNICN: "G101.555/O_D", DJI: "@@INDU/DJI_D", SPX: "@@CSPX/SPI", IXIC: "@@CCO/NDI_D",
  SOX: "@@SOXX/NDI_D", VIX: "@@VIX/SPI", USDJPY: "XJPY/7", US10YT: "BUSG.10Y/TLTL", CLC1: "FCL.1/NMXE_D",
};
// "60,830"・"-320"・"159.66-159.68"（為替は売り買いの幅）→ 数。幅は前の値を使う
const nkNum = (s) => { const m = String(s || "").replace(/,/g, "").match(/^[+-]?\d+(\.\d+)?/); return m ? num(m[0]) : null; };

// ---------- part=markets ----------
async function partMarkets(wanted, months) {
  const errors = [];
  const nkPairs = [["indexes", "NK225"], ["commodities_futures", "JNICN"], ...MARKETS.filter((m) => m.nk).map((m) => m.nk)];
  const [daily, nk, cme] = await Promise.all([
    Promise.all(MARKETS.map((m) => yahooDaily(m.symbol).catch((e) => ({ error: errMsg(e) })))),
    nikkeiValues(nkPairs).catch((e) => ({ __error: errMsg(e) })),
    yahooDaily("NIY=F", "1mo").catch((e) => ({ error: errMsg(e) })),
  ]);
  if (nk.__error) errors.push(`日経の API：${nk.__error}`);

  const spxIdx = MARKETS.findIndex((m) => m.key === "spx");
  const spx = daily[spxIdx];
  const base = spx && !spx.error ? spx : daily.find((d) => !d.error && d.meta && d.meta.instrumentType === "INDEX");
  if (!base) return { ok: false, error: "Yahoo から米国の指数が取れませんでした", errors: [...errors, ...daily.map((d) => d.error).filter(Boolean)] };
  const td = decideTargetDate(base, wanted);

  const since = new Date(td.target + "T00:00:00Z");
  since.setUTCMonth(since.getUTCMonth() - months);
  const sinceStr = since.toISOString().slice(0, 10);

  const markets = MARKETS.map((m, i) => {
    const d = daily[i];
    const row = { key: m.key, name: m.name, symbol: m.symbol, scene: m.scene, unit: m.unit || "" };
    if (d && !d.error) {
      const p = pickDay(d.bars, td.target);
      if (p) {
        Object.assign(row, { source: "Yahoo", date: p.date, value: round(p.value, 4), change: round(p.change, 4), pct: round(p.pct, 2) });
        if (m.key === "us10y") row.changeBp = round(p.change * 100, 1);   // 金利は bp でも出す
        if (p.date !== td.target) row.note = `${td.target} の値が無いので ${p.date} の値`;
        if (m.chart) row.history = d.bars.filter((b) => b.date >= sinceStr && b.date <= td.target).map((b) => ({ date: b.date, close: round(b.close, 2) }));
        return row;
      }
    }
    // 予備：日経の API（その時点の値。チャートは無し）
    const n = m.nk && !nk.__error ? nk[m.nk[1]] : null;
    if (n && nkNum(n.value) !== null) {
      Object.assign(row, { source: "日経", time: n.time, value: nkNum(n.value), change: nkNum(n.diff), pct: num(n.diffPercent), note: "Yahoo が取れず日経の値（取った時点の値）" });
      if (m.key === "us10y") row.changeBp = round(nkNum(n.diff) * 100, 1);
    } else {
      row.error = (d && d.error) || "値が取れませんでした";
      errors.push(`${m.name}：${row.error}`);
    }
    return row;
  });

  // 日経先物：大阪の夜間を主に、取れなければ CME
  let futures = null;
  const nk225 = !nk.__error ? nk.NK225 : null;
  const nk225Close = nk225 ? nkNum(nk225.value) : null;
  const osaka = !nk.__error ? nk.JNICN : null;
  if (osaka && nkNum(osaka.value) !== null) {
    const v = nkNum(osaka.value);
    futures = { source: "大阪（夜間）", time: osaka.time, value: v, change: nkNum(osaka.diff), pct: num(osaka.diffPercent) };
  } else if (cme && !cme.error && cme.bars.length) {
    const last = cme.bars[cme.bars.length - 1];
    futures = { source: "CME", time: jstLabel(cme.meta.regularMarketTime || last.t), value: last.close, note: "大阪の値が取れず CME（シカゴ）の値" };
  } else {
    errors.push("日経先物：大阪・CME ともに取れませんでした");
  }
  if (futures) {
    futures.nk225Close = nk225Close;
    futures.nk225Time = nk225 ? nk225.time : "";
    if (nk225Close !== null) futures.vsNk225 = round(futures.value - nk225Close, 2);   // 日経平均の前日終値より○円高い／安い
  }

  return { ok: true, targetDate: td.target, prevDate: td.prev, inSession: td.inSession, markets, nikkeiFutures: futures, errors };
}

// ---------- 天気 ----------
export const DEFAULT_TH = { eu: 3, ed: -1, su: 1, sd: -0.5, small: 0.1 };
// 晴れ／曇り／雨。比べられなければ null（画面では「－」）
export function weatherOf(act, est, kind, th = DEFAULT_TH) {
  if (act === null || est === null) return { weather: null, diffPct: null };
  // 予想が赤字やゼロに近い EPS は、％ではなく向きだけで決める
  if (kind === "eps" && Math.abs(est) < th.small) {
    const w = act > est ? "晴れ" : act < est ? "雨" : "曇り";
    return { weather: w, diffPct: null, bySign: true };
  }
  if (est === 0) return { weather: null, diffPct: null };
  const p = ((act - est) / Math.abs(est)) * 100;
  const [up, down] = kind === "eps" ? [th.eu, th.ed] : [th.su, th.sd];
  return { weather: p >= up ? "晴れ" : p < down ? "雨" : "曇り", diffPct: round(p, 2) };
}

// ---------- 決算 ----------
async function nasdaqDay(date) {
  const d = await getJson(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { Accept: "application/json, text/plain, */*" });
  const rows = (d && d.data && d.data.rows) || [];
  const tmap = { "time-pre-market": "bmo", "time-after-hours": "amc" };
  return rows.map((r) => ({
    symbol: String(r.symbol || "").toUpperCase(),
    name: r.name || "",
    hour: tmap[r.time] || "",
    mcap: num(String(r.marketCap || "").replace(/[$,]/g, "")),
    epsEstimate: (() => { const s = String(r.epsForecast || ""); const v = num(s.replace(/[$,()]/g, "")); return v === null ? null : /\(/.test(s) ? -v : v; })(),
    date,
  }));
}

async function finnhubRange(from, to, key) {
  const d = await getJson(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(key)}`);
  return ((d && d.earningsCalendar) || []).map((r) => ({
    symbol: String(r.symbol || "").toUpperCase(), date: r.date, hour: r.hour || "",
    epsEstimate: num(r.epsEstimate), epsActual: num(r.epsActual),
    revenueEstimate: num(r.revenueEstimate), revenueActual: num(r.revenueActual),
    quarter: r.quarter, year: r.year,
  }));
}

// 秒 → ニューヨークの日付
const nyDate = (sec) => tzDate(sec, "America/New_York");

// 公式の終値（日足）を20銘柄ずつまとめて取る（Yahoo の spark）。{ CSCO: [{date, close}], ... }
async function yahooSparkDaily(symbols) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  await Promise.all(chunks.map(async (c) => {
    const d = await getJson(`${YH}/v8/finance/spark?symbols=${c.map(encodeURIComponent).join(",")}&range=1mo&interval=1d`);
    for (const s of c) {
      const r = d && d[s];
      if (!r || !r.timestamp) continue;
      const bars = [];
      r.timestamp.forEach((t, i) => { const v = num(r.close[i]); if (v !== null) bars.push({ date: nyDate(t), close: v }); });
      out[s] = bars;
    }
  }));
  return out;
}

// 5分足（時間外つき）から、対象日の引け後の最後の値と時刻
async function yahooAfterHours(symbol, target) {
  const d = await getJson(`${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`);
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw new Error("5分足がありません");
  const meta = r.meta, q = r.indicators.quote[0], ts = r.timestamp;
  const posts = ((meta.tradingPeriods || {}).post || []).map((x) => (Array.isArray(x) ? x[0] : x)).filter(Boolean);
  const post = posts.find((p) => nyDate(p.start) === target);
  if (!post) return null;
  let v = null, t = null;
  ts.forEach((s, i) => { const c = num(q.close[i]); if (c !== null && s >= post.start && s < post.end) { v = c; t = s; } });
  return v === null ? null : { price: v, time: jstLabel(t) };
}

async function partEarnings({ target, prev, env, must, minCap, max, th }) {
  const errors = [];
  const key = env.FINNHUB_API_KEY || "";
  const [nqT, nqP, fh] = await Promise.all([
    nasdaqDay(target).catch((e) => { errors.push(`Nasdaq（${target}）：${errMsg(e)}`); return []; }),
    prev ? nasdaqDay(prev).catch((e) => { errors.push(`Nasdaq（${prev}）：${errMsg(e)}`); return []; }) : [],
    key ? finnhubRange(prev || target, target, key).catch((e) => { errors.push(`Finnhub：${errMsg(e)}`); return null; }) : null,
  ]);
  if (!key) errors.push("FINNHUB_API_KEY が未設定です（売上の予想・実績と EPS の実績が入りません。EPS の予想は Nasdaq の値）");

  // 対象にする決算：前日の引け後・当日の寄り前（当日の値動きに出る）と、当日の引け後（時間外に出る）
  const rows = new Map();
  const add = (r, src) => {
    const k = r.symbol;
    if (!k) return;
    const cur = rows.get(k) || { symbol: k };
    for (const [f, v] of Object.entries(r)) if (v !== null && v !== undefined && v !== "" && (cur[f] === undefined || cur[f] === null || cur[f] === "" || src === "finnhub")) cur[f] = v;
    if (src === "nasdaq") { cur.mcap = r.mcap; if (r.name) cur.name = r.name; if (!cur.hour && r.hour) cur.hour = r.hour; }
    rows.set(k, cur);
  };
  for (const r of [...nqP, ...nqT]) add(r, "nasdaq");
  if (fh) for (const r of fh) {
    const ex = rows.get(r.symbol);
    // Finnhub と Nasdaq の日付が違うものは Finnhub に合わせる。発表の時間は Finnhub を優先（無ければ Nasdaq）
    add({ ...r, hour: r.hour || (ex && ex.hour) || "" }, "finnhub");
  }
  const timing = (r) => {
    if (r.date === prev && r.hour === "amc") return "reacted";          // 前日の引け後 → 当日の値動き
    if (r.date === target && r.hour === "amc") return "afterhours";     // 当日の引け後 → 時間外
    if (r.date === target) return "reacted";                            // 当日の寄り前・場中・不明
    return null;                                                         // 前日の寄り前などは対象外
  };
  const mustSet = new Set(must);
  let list = [...rows.values()].map((r) => ({ ...r, session: timing(r), must: mustSet.has(r.symbol) })).filter((r) => r.session);
  const total = list.length;
  list = list.filter((r) => r.must || (r.mcap !== null && r.mcap !== undefined && r.mcap >= minCap));
  list.sort((a, b) => (b.must - a.must) || ((b.mcap || 0) - (a.mcap || 0)));
  // Cloudflare の外への取得の回数に上限（無料は1回の呼び出しで50）があるので、
  // 値動きは時価総額の大きい順に60銘柄まで（日足は20銘柄ずつまとめて取る）、時間外の5分足は当日の引け後の25銘柄まで
  const PRICE_LIMIT = 60, AH_LIMIT = 25;
  const priced = list.slice(0, PRICE_LIMIT);
  if (list.length > PRICE_LIMIT) errors.push(`時価総額の条件に合う決算が ${list.length} 件あり、値動きは大きい順に ${PRICE_LIMIT} 件だけ取りました`);
  const ahTargets = priced.filter((r) => r.session === "afterhours").slice(0, AH_LIMIT).map((r) => r.symbol);
  const [daily, ahList] = await Promise.all([
    yahooSparkDaily(priced.map((r) => r.symbol)).catch((e) => { errors.push(`Yahoo の日足：${errMsg(e)}`); return {}; }),
    Promise.all(ahTargets.map((s) => yahooAfterHours(s, target).catch(() => null))),
  ]);
  const ah = Object.fromEntries(ahTargets.map((s, i) => [s, ahList[i]]));
  const prices = priced.map((r) => {
    const p = daily[r.symbol] ? pickDay(daily[r.symbol], target) : null;
    const o = {};
    if (!p || p.date !== target) o.error = "対象日の終値が取れませんでした";
    else {
      o.dayPct = round(p.pct, 2);
      const a = ah[r.symbol];
      if (a) { o.afterPct = round(((a.price - p.value) / p.value) * 100, 2); o.afterTime = a.time; }
    }
    return o;
  });

  const out = priced.map((r, i) => {
    const p = prices[i];
    const eps = weatherOf(num(r.epsActual), num(r.epsEstimate), "eps", th);
    const rev = weatherOf(num(r.revenueActual), num(r.revenueEstimate), "rev", th);
    const row = {
      symbol: r.symbol, name: r.name || p.name || "", mcap: r.mcap ?? null, reportDate: r.date, hour: r.hour || "",
      session: r.session, hourUnknown: !r.hour, must: r.must,   // hourUnknown：寄り前か引け後か分からない（Finnhub が無いとき）
      eps: { estimate: num(r.epsEstimate), actual: num(r.epsActual), ...eps },
      revenue: { estimate: num(r.revenueEstimate), actual: num(r.revenueActual), ...rev },
      guidance: null,   // AI がニュースから判定する（方針どおり）
      dayPct: p.dayPct ?? null, afterPct: p.afterPct ?? null, afterTime: p.afterTime || "",
      actualFrom: num(r.epsActual) !== null || num(r.revenueActual) !== null ? "Finnhub" : "",
    };
    if (p.error) row.priceError = p.error;
    // 選ぶときの値動き：当日の引け後に出たものは時間外、それ以外は当日
    row.move = row.session === "afterhours" ? row.afterPct : row.dayPct;
    return row;
  });

  // 載せる銘柄：必ず載せる銘柄 → 値動きの大きい順で max 件まで
  const pickOrder = [...out].sort((a, b) => (b.must - a.must) || (Math.abs(b.move ?? 0) - Math.abs(a.move ?? 0)));
  const picked = new Set(pickOrder.slice(0, max).map((r) => r.symbol));
  for (const r of out) r.picked = picked.has(r.symbol);
  out.sort((a, b) => (b.picked - a.picked) || (b.must - a.must) || (Math.abs(b.move ?? 0) - Math.abs(a.move ?? 0)));

  return {
    ok: true, targetDate: target, prevDate: prev, finnhub: !!fh, thresholds: th, minCap, totalReports: total,
    rows: out, missingActual: out.filter((r) => r.picked && r.eps.actual === null).map((r) => r.symbol), errors,
  };
}

// ---------- 変動率の高い銘柄 ----------
async function partMovers(minCap) {
  const errors = [];
  const ids = { gainers: "day_gainers", losers: "day_losers", actives: "most_actives" };
  const res = await Promise.all(Object.values(ids).map((id) =>
    getJson(`${YH}/v1/finance/screener/predefined/saved?scrIds=${id}&count=50`).catch((e) => { errors.push(`${id}：${errMsg(e)}`); return null; })));
  const out = {};
  let asOf = 0;
  Object.keys(ids).forEach((k, i) => {
    const r = res[i] && res[i].finance && res[i].finance.result && res[i].finance.result[0];
    out[k] = ((r && r.quotes) || [])
      .filter((q) => (q.marketCap || 0) >= minCap && q.quoteType === "EQUITY")
      .slice(0, 25)
      .map((q) => {
        asOf = Math.max(asOf, q.regularMarketTime || 0);
        return {
          symbol: q.symbol, name: q.longName || q.shortName || "", pct: round(num(q.regularMarketChangePercent), 2),
          price: num(q.regularMarketPrice), mcap: num(q.marketCap), volume: num(q.regularMarketVolume),
          earnings: q.earningsTimestamp ? jstLabel(q.earningsTimestamp) : "",
        };
      });
  });
  return { ok: Object.values(out).some((a) => a.length), asOf: asOf ? jstLabel(asOf) : "", minCap, ...out, errors };
}

// ---------- 日本語の社名（part=names&symbols=CSCO,NBIS…）----------
// 株探（米国株）の銘柄ページの og:title「シスコ・システムズ (Cisco Systems, Inc.)【CSCO】」から読む。1回の呼び出しで40銘柄まで
async function partNames(symbols) {
  const list = [...new Set(symbols)].slice(0, 40);
  const names = {};
  await Promise.all(list.map(async (sym) => {
    try {
      const r = await fetch(`https://us.kabutan.jp/stocks/${encodeURIComponent(sym.replace(/-/g, "."))}`, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
      if (!r.ok) return;
      const m = (await r.text()).match(/property=['"]og:title['"]\s+content=["']([^"']+?)\s*[（(][^【]*【/);
      const ja = m ? m[1].replace(/&amp;/g, "&").trim() : "";
      if (ja) names[sym] = ja;
    } catch (e) {}
  }));
  return { ok: true, names, missing: list.filter((s) => !names[s]) };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sp = url.searchParams;
  const part = sp.get("part") || "all";
  if (part === "names") {
    const symbols = (sp.get("symbols") || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s));
    return json({ part, ...(await partNames(symbols)) });
  }
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") || "") ? sp.get("date") : "";
  const fnum = (k, d) => (sp.get(k) !== null && isFinite(parseFloat(sp.get(k))) ? parseFloat(sp.get(k)) : d);
  const out = { fetchedAt: new Date().toISOString(), part };
  try {
    // 対象日はどの part でも S&P500 の日足から決める
    const spx = await yahooDaily("^GSPC", "1mo");
    const td = decideTargetDate(spx, wanted);
    Object.assign(out, { targetDate: td.target, prevDate: td.prev, inSession: td.inSession });

    const jobs = {};
    if (part === "all" || part === "markets") jobs.markets = partMarkets(td.target, Math.min(12, Math.max(1, fnum("months", 3))));
    if (part === "all" || part === "earnings") {
      const must = (sp.get("must") || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      const th = { eu: fnum("eu", DEFAULT_TH.eu), ed: fnum("ed", DEFAULT_TH.ed), su: fnum("su", DEFAULT_TH.su), sd: fnum("sd", DEFAULT_TH.sd), small: fnum("small", DEFAULT_TH.small) };
      jobs.earnings = partEarnings({ target: td.target, prev: td.prev, env, must, minCap: fnum("mcap", 10) * 1e9, max: Math.max(1, Math.min(16, fnum("max", 16))), th });
    }
    if (part === "all" || part === "movers") jobs.movers = partMovers(fnum("mcap", 2) * 1e9);
    if (!Object.keys(jobs).length) return json({ ok: false, error: `part=${part} は使えません（markets・earnings・movers）` }, 400);
    const keys = Object.keys(jobs);
    const vals = await Promise.all(keys.map((k) => jobs[k].catch((e) => ({ ok: false, error: errMsg(e) }))));
    keys.forEach((k, i) => (out[k] = vals[i]));
    out.ok = vals.every((v) => v.ok);
    if (!out.ok) out.error = keys.filter((k, i) => !vals[i].ok).map((k) => `${k}：${out[k].error || "取得できませんでした"}`).join(" / ");
    return json(out);
  } catch (e) {
    return json({ ...out, ok: false, error: errMsg(e) });
  }
}
