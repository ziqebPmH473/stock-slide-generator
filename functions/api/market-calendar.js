// ============================================================
// CF Pages Function: /api/market-calendar（2026-11-14）
// 市場の休みのカレンダーを取って R2（STATE）の cal/market-calendar.json に保管し、それを返す。
// 米国版の「数字を読んでよいか（確定／取引中）」の判定に使う（us.js の usFixed）。
//
// ・日本の祝日 … 内閣府の CSV（翌年の分まで載っている）
// ・大阪の先物の祝日取引 … JPX の「祝日取引実施日」の表（祝日でも取引する日・しない日）
// ・米国の休場日 … Finnhub（/stock/market-holiday。FINNHUB_API_KEY）。取れなければ決まりから計算した休場日
//
// 取り直すとき（Pages には定時に動かす仕組みが無いので、呼ばれたときに確かめる）：
//   保管が無い／取ってから REFRESH_DAYS 日たった／カレンダーの最後の日（until）まで AHEAD_DAYS 日を切った／?refresh=1
// 取り直しに失敗した取得先は、前に保管した分をそのまま使う（errors に理由を残す）。
// R2 が紐づいていないときは、その場で取って返すだけ（保管しない）。
// ============================================================

const KEY = "cal/market-calendar.json";
const REFRESH_DAYS = 30;   // 取ってからこの日数で取り直す（JPX の表は6月・12月に確定が出る）
const AHEAD_DAYS = 60;     // カレンダーの最後の日までこの日数を切ったら取り直す
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
const errMsg = (e) => String(e && e.message ? e.message : e);
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// ---------- 日本の祝日（内閣府）----------
// CSV は Shift_JIS だが、日付の列は英数字だけなので、名前は読まずに日付だけ拾う
async function fetchJpHolidays() {
  const r = await fetch("https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv", { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`内閣府 HTTP ${r.status}`);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(await r.arrayBuffer());
  const thisYear = new Date().getUTCFullYear();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}),/);
    if (m && +m[1] >= thisYear - 1) out.push(iso(m[1], m[2], m[3]));
  }
  if (out.length < 10) throw new Error("内閣府の祝日が読めませんでした");
  return out;
}

// ---------- 大阪の祝日取引（JPX）----------
// 表は「2026年 1月2日 金 年始休業日 実施しない（注4） 確定 1月12日 月 成人の日 実施する 確定 …」と並ぶ
async function fetchJpxHolidayTrading() {
  const r = await fetch("https://www.jpx.co.jp/derivatives/rules/holidaytrading/index.html", { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!r.ok) throw new Error(`JPX HTTP ${r.status}`);
  const text = (await r.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const out = {};
  let year = null;
  const re = /(20\d\d)年(?=\s+\d{1,2}月\d{1,2}日\s+[月火水木金土日]\s)|(\d{1,2})月(\d{1,2})日\s+[月火水木金土日]\s+\S+\s+(実施する|実施しない)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) { year = m[1]; continue; }
    if (year) out[iso(year, m[2], m[3])] = m[4] === "実施する";
  }
  if (Object.keys(out).length < 5) throw new Error("JPX の祝日取引の表が読めませんでした");
  return out;
}

// ---------- 米国の休場日 ----------
async function fetchUsHolidaysFinnhub(key) {
  const r = await fetch(`https://finnhub.io/api/v1/stock/market-holiday?exchange=US&token=${encodeURIComponent(key)}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
  const d = await r.json();
  const rows = (d && d.data) || [];
  const holidays = [], early = [];
  for (const x of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.atDate || "")) continue;
    (x.tradingHour ? early : holidays).push(x.atDate);   // tradingHour があれば短縮取引の日（休みではない）
  }
  if (holidays.length < 5) throw new Error("Finnhub の休場日が読めませんでした");
  return { holidays: holidays.sort(), early: early.sort() };
}
// 決まりから計算（NYSE の休場日。土曜に当たれば金曜、日曜に当たれば月曜に振り替え）。Finnhub が使えないときの予備
function usHolidaysByRule(year) {
  const d = (m, day) => new Date(Date.UTC(year, m - 1, day));
  const nth = (m, wd, n) => { const f = d(m, 1); return d(m, 1 + ((7 + wd - f.getUTCDay()) % 7) + (n - 1) * 7); };
  const last = (m, wd) => { const l = new Date(Date.UTC(year, m, 0)); return d(m, l.getUTCDate() - ((7 + l.getUTCDay() - wd) % 7)); };
  const obs = (x) => { const w = x.getUTCDay(); return w === 6 ? new Date(x.getTime() - 864e5) : w === 0 ? new Date(x.getTime() + 864e5) : x; };
  // 聖金曜日（復活祭の2日前）
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const em = Math.floor((h + l - 7 * mm + 114) / 31), ed = ((h + l - 7 * mm + 114) % 31) + 1;
  const goodFriday = new Date(Date.UTC(year, em - 1, ed) - 2 * 864e5);
  const list = [obs(d(1, 1)), nth(1, 1, 3), nth(2, 1, 3), goodFriday, last(5, 1), obs(d(6, 19)), obs(d(7, 4)), nth(9, 1, 1), nth(11, 4, 4), obs(d(12, 25))];
  // 元日が土曜のときは振り替えない（NYSE の決まり）
  return list.filter((x) => x.getUTCFullYear() === year).map((x) => x.toISOString().slice(0, 10));
}

async function build(env, prev) {
  const errors = [];
  const now = new Date();
  const y = now.getUTCFullYear();
  const [jp, jpx, us] = await Promise.all([
    fetchJpHolidays().catch((e) => { errors.push(`日本の祝日：${errMsg(e)}`); return null; }),
    fetchJpxHolidayTrading().catch((e) => { errors.push(`祝日取引：${errMsg(e)}`); return null; }),
    env.FINNHUB_API_KEY ? fetchUsHolidaysFinnhub(env.FINNHUB_API_KEY).catch((e) => { errors.push(`米国の休場日：${errMsg(e)}`); return null; }) : null,
  ]);
  const rule = [...usHolidaysByRule(y - 1), ...usHolidaysByRule(y), ...usHolidaysByRule(y + 1)];
  const cal = {
    version: 1, fetchedAt: now.toISOString(),
    jp: {
      holidays: jp || (prev && prev.jp && prev.jp.holidays) || [],
      holidayTrading: jpx || (prev && prev.jp && prev.jp.holidayTrading) || {},
    },
    // Finnhub に載っていない年（前の年・先の年）は、決まりから計算した休場日で埋める
    us: us ? { holidays: [...new Set([...us.holidays, ...rule.filter((d) => d.slice(0, 4) < us.holidays[0].slice(0, 4) || d.slice(0, 4) > us.holidays[us.holidays.length - 1].slice(0, 4))])].sort(), early: us.early } : { holidays: rule, early: (prev && prev.us && prev.us.early) || [] },
    sources: { jpHolidays: jp ? "内閣府" : "前の保管", holidayTrading: jpx ? "JPX" : "前の保管", usHolidays: us ? "Finnhub" : "決まりから計算" },
    errors,
  };
  // until：このカレンダーで判定できる最後の日（日本の祝日と米国の休場日の、それぞれの最後の日がある年の年末のうち早いほう）
  const lastYear = (arr) => (arr.length ? arr[arr.length - 1].slice(0, 4) : String(y));
  cal.until = `${Math.min(+lastYear(cal.jp.holidays), +lastYear(cal.us.holidays))}-12-31`;
  return cal;
}

function stale(cal) {
  if (!cal || !cal.fetchedAt || !cal.until) return "保管がありません";
  const now = Date.now(), age = now - Date.parse(cal.fetchedAt);
  if (age > REFRESH_DAYS * 864e5) return `取ってから${REFRESH_DAYS}日たちました`;
  // 最後の日が近いのに、取得先にまだ先の分が出ていないことがある。そのときは呼ばれるたびに取り直さず、1日おきに確かめる
  if (age > 864e5 && Date.parse(cal.until + "T00:00:00Z") - now < AHEAD_DAYS * 864e5) return `最後の日（${cal.until}）まで${AHEAD_DAYS}日を切りました`;
  if (age > 864e5 && (cal.errors || []).length) return "前回取れなかった取得先があります";
  return "";
}

export async function onRequestGet({ request, env }) {
  const force = new URL(request.url).searchParams.get("refresh");
  let cal = null;
  if (env.STATE) {
    try { const o = await env.STATE.get(KEY); if (o) cal = JSON.parse(await o.text()); } catch (e) {}
  }
  const why = force ? "手動の取り直し" : stale(cal);
  if (why) {
    try {
      const next = await build(env, cal);
      next.refreshedBecause = why;
      cal = next;
      if (env.STATE) await env.STATE.put(KEY, JSON.stringify(cal), { httpMetadata: { contentType: "application/json" } });
    } catch (e) {
      if (!cal) return json({ ok: false, error: `カレンダーを取れませんでした：${errMsg(e)}` });
      cal.errors = [...(cal.errors || []), `取り直しに失敗：${errMsg(e)}`];
    }
  }
  return json({ ok: true, stored: !!env.STATE, ...cal });
}
