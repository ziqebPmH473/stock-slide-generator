// ============================================================
// アカウントごとの使える範囲（回数・時間帯・機能）と、使った記録（2026-11-13）
// ・誰が使っているかは Cloudflare Access が付けるメールアドレス（Cf-Access-Authenticated-User-Email）で見る。
// ・管理者は環境変数 ADMIN_EMAILS（カンマ区切り）。管理者は制限なし。ローカル（localhost）も管理者扱い。
//   ADMIN_EMAILS が未設定のあいだは、全員を今までどおり（制限なし・記録だけ）にし、管理画面は誰も開けない。
// ・設定・回数・記録は R2（STATE）の acl/ の下に置く（作業の保存 m/・p/ とは別の場所）。
//   acl/config.json                   … アカウントごとの設定（管理画面で変える）
//   acl/usage/<日付>/<メール>.json      … その日に使った回数（日本時間の日付）
//   acl/log/<日付>/<時刻>-<乱数>        … 1回の操作の記録（中身は customMetadata に入れ、一覧だけで読める）
// ============================================================

export const CATEGORIES = {
  ai: "文章の AI",
  tts: "音声生成",
  image: "画像生成",
  transcribe: "文字起こし",
  fetch: "データ取得",
  save: "作業の保存",
};
// 回数の上限を付けられるもの（保存は記録だけ）
export const LIMITABLE = ["ai", "tts", "image", "transcribe", "fetch"];
export const KEEP_LOG_DAYS = 30;

export function jstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
export function jstDate(d = jstNow()) {
  return d.toISOString().slice(0, 10);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function isLocal(request) {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

// ログインした人のメールアドレス（小文字）。ローカルは "local"。分からなければ ""
export function userOf(request) {
  if (isLocal(request)) return "local";
  return String(request.headers.get("Cf-Access-Authenticated-User-Email") || "").trim().toLowerCase();
}

export function adminList(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// 管理者か（制限をかけない人）。ADMIN_EMAILS が未設定なら全員を今までどおりにする
export function isAdmin(env, user) {
  if (user === "local") return true;
  const list = adminList(env);
  if (!list.length) return true;
  return !!user && list.includes(user);
}

// 管理画面を開けるか（ADMIN_EMAILS に入っている人とローカルだけ）
export function canAdmin(env, user) {
  if (user === "local") return true;
  const list = adminList(env);
  return !!user && list.includes(user);
}

// どの機能の呼び出しか。数えない・記録しないものは ""
export function categoryOf(method, path, url) {
  if (path === "/api/analyze") return "ai";
  if (path === "/api/gemini-key") return "ai-key";   // 数えないが、キーを渡すかどうかをここで決める
  if (path === "/api/tts") return "tts";
  if (path === "/api/image") return "image";
  if (path === "/api/transcribe") return "transcribe";
  if (path === "/api/fetch-sources" || path === "/api/index-history") return "fetch";
  // 保存は目録（1日の作業のまとめ）を置いたときだけ記録する（中身の1つずつは数えない）
  if (path === "/api/state" && method === "PUT" && url && !url.searchParams.get("part")) return "save";
  return "";
}

const DEFAULT_POLICY = { label: "", directAI: false, hours: null, limits: {}, disabled: [] };

export async function loadConfig(env) {
  try {
    const o = await env.STATE.get("acl/config.json");
    if (!o) return { users: {}, default: { ...DEFAULT_POLICY } };
    const c = JSON.parse(await o.text());
    return { users: c.users || {}, default: { ...DEFAULT_POLICY, ...(c.default || {}) } };
  } catch (e) {
    return { users: {}, default: { ...DEFAULT_POLICY } };
  }
}

// 管理画面から受け取った設定を、決まった形に揃える（知らない項目は捨てる）
export function cleanConfig(input) {
  const cleanPolicy = (p) => {
    p = p || {};
    const out = { label: String(p.label || "").slice(0, 40), directAI: p.directAI === true, hours: null, limits: {}, disabled: [] };
    if (p.hours && Number.isInteger(p.hours.from) && Number.isInteger(p.hours.to)
      && p.hours.from >= 0 && p.hours.from <= 24 && p.hours.to >= 0 && p.hours.to <= 24 && p.hours.from !== p.hours.to) {
      out.hours = { from: p.hours.from, to: p.hours.to };
    }
    for (const k of LIMITABLE) {
      const v = p.limits && p.limits[k];
      if (Number.isInteger(v) && v >= 0 && v <= 100000) out.limits[k] = v;
    }
    out.disabled = (Array.isArray(p.disabled) ? p.disabled : []).filter((k) => LIMITABLE.includes(k));
    return out;
  };
  const users = {};
  for (const [email, p] of Object.entries((input && input.users) || {})) {
    const e = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) continue;
    users[e] = cleanPolicy(p);
  }
  return { users, default: cleanPolicy(input && input.default) };
}

export function policyFor(config, user) {
  return config.users[user] || config.default;
}

// 時間帯（日本時間の from 時〜to 時の前まで。to < from なら日をまたぐ）
export function inHours(hours, d = jstNow()) {
  if (!hours) return true;
  const h = d.getUTCHours();
  return hours.from < hours.to ? (h >= hours.from && h < hours.to) : (h >= hours.from || h < hours.to);
}

function usageKey(date, user) {
  return `acl/usage/${date}/${encodeURIComponent(user || "unknown")}.json`;
}

export async function getUsage(env, user, date = jstDate()) {
  try {
    const o = await env.STATE.get(usageKey(date, user));
    return o ? JSON.parse(await o.text()) : {};
  } catch (e) {
    return {};
  }
}

// 回数は「ボタン1回＝1回」で数える（2026-11-14）。
// ・画面は、押したボタンの名前（X-SSG-Button）と押した1回ごとの印（X-SSG-Press）を /api の呼び出しに付ける（index.html の先頭）。
//   同じ印の呼び出し（動画の読み上げを場面ごとに呼ぶなど）は、最初の1回だけ数える。
// ・印が無い呼び出し（ボタンを押さずに自動で動いたもの、画面を通さない呼び出し）は、
//   前の呼び出しから GROUP_GAP_MS 以内なら同じ操作の続きとしてまとめる。
export const GROUP_GAP_MS = 3 * 60 * 1000;
const KEEP_PRESSES = 40;   // 機能ごとに覚えておく、最近の印の数

// 画面が付けたボタンの名前と印（無ければ空）
export function pressOf(request) {
  let button = "";
  try { button = decodeURIComponent(request.headers.get("X-SSG-Button") || ""); } catch (e) {}
  button = button.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  const press = String(request.headers.get("X-SSG-Press") || "").replace(/[^0-9a-z]/gi, "").slice(0, 24);
  return { button, press };
}

// いまの呼び出しが、すでに数えた操作の続きか（上限に達していても、始まった操作は最後まで通すため）
export function isContinuation(u, cat, press, now = Date.now()) {
  if (press) return (u[cat + "Presses"] || []).includes(press);
  return !!u[cat + "Last"] && now - u[cat + "Last"] < GROUP_GAP_MS;
}

// その日の回数を数える。
// cat＝操作の回数（続きは数えない）、catCalls＝呼び出しの回数、catChars＝文字数、catLast＝最後に呼んだ時刻、catPresses＝最近の印
// buttons＝{ "機能|ボタンの名前": { cat, button, n: 操作の回数, calls: 呼び出しの回数 } }
// （R2 は足し算を一度にできないので、同時に叩かれると1回ぶんずれることがある）
export async function addUsage(env, user, cat, extra) {
  const date = jstDate();
  const u = await getUsage(env, user, date);
  const now = Date.now();
  const press = (extra && extra.press) || "";
  const cont = isContinuation(u, cat, press, now);
  if (!cont) u[cat] = (u[cat] || 0) + 1;
  u[cat + "Calls"] = (u[cat + "Calls"] || 0) + 1;
  u[cat + "Last"] = now;
  if (press && !cont) u[cat + "Presses"] = [...(u[cat + "Presses"] || []), press].slice(-KEEP_PRESSES);
  if (extra && extra.chars) u[cat + "Chars"] = (u[cat + "Chars"] || 0) + extra.chars;
  const button = (extra && extra.button) || "（ボタンなし・自動）";
  u.buttons = u.buttons || {};
  const b = u.buttons[cat + "|" + button] || (u.buttons[cat + "|" + button] = { cat, button, n: 0, calls: 0 });
  if (!cont) b.n += 1;
  b.calls += 1;
  await env.STATE.put(usageKey(date, user), JSON.stringify(u), { httpMetadata: { contentType: "application/json" } });
  return cont;
}

export async function writeLog(env, entry) {
  const now = jstNow();
  const key = `acl/log/${jstDate(now)}/${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const meta = { time: now.toISOString().slice(11, 19) };   // 日本時間の時刻
  for (const [k, v] of Object.entries(entry)) if (v !== undefined && v !== null && v !== "") meta[k] = String(v).slice(0, 300);
  await env.STATE.put(key, "", { customMetadata: meta });
}

export async function readLogs(env, date, limit = 500) {
  const out = [];
  let cursor;
  do {
    const r = await env.STATE.list({ prefix: `acl/log/${date}/`, cursor, include: ["customMetadata"] });
    for (const o of r.objects) out.push({ key: o.key, ...(o.customMetadata || {}) });
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor && out.length < 5000);
  out.sort((a, b) => (a.key < b.key ? 1 : -1));   // 新しい順
  return out.slice(0, limit).map(({ key, ...rest }) => rest);
}

// 記録のある日付の一覧（新しい順）
export async function logDates(env) {
  const r = await env.STATE.list({ prefix: "acl/log/", delimiter: "/" });
  return (r.delimitedPrefixes || []).map((p) => p.slice("acl/log/".length, -1)).sort().reverse();
}

// KEEP_LOG_DAYS 日より前の記録・回数を消す（管理画面を開いたときについでに行う）
export async function cleanupOld(env) {
  const limit = jstDate(new Date(jstNow().getTime() - KEEP_LOG_DAYS * 86400000));
  for (const base of ["acl/log/", "acl/usage/"]) {
    const r = await env.STATE.list({ prefix: base, delimiter: "/" });
    for (const p of r.delimitedPrefixes || []) {
      const d = p.slice(base.length, -1);
      if (d >= limit) continue;
      let cursor;
      do {
        const l = await env.STATE.list({ prefix: p, cursor });
        if (l.objects.length) await env.STATE.delete(l.objects.map((o) => o.key));
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
    }
  }
}
