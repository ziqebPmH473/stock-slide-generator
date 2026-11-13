// ============================================================
// /api/〜 の入口（2026-11-13）：アカウントごとの制限と、使った記録
// ・誰が：Cloudflare Access のメールアドレス（functions/_shared/acl.js の userOf）
// ・止める：機能を使わせない／時間帯の外／その日の上限に達した → 403・429 と理由を返す（画面にはそのまま出る）
// ・数える：成功したとき（2xx）だけ、その日の回数を1つ増やす。前の呼び出しから3分以内の続きは同じ操作として数えない（ボタン1回＝1回）
// ・記録：数える機能はすべて、成功・失敗・止めたも含めて1回ずつ残す（管理画面で見る）
// ・R2（STATE）が紐づいていないときは、今までどおり何もしない
// ・文章の AI は、画面にキーを渡すと画面から直接呼ばれて数えられないため、
//   管理者以外は「AI を直接呼ぶ（directAI）」を管理画面でオンにした人にだけキーを渡す。
//   渡さない人は、画面が自動で /api/analyze（ここを通る）を使う。
// ============================================================
import {
  CATEGORIES, LIMITABLE, json, userOf, isAdmin, categoryOf, loadConfig, policyFor, inHours,
  getUsage, addUsage, writeLog, isContinuation,
} from "../_shared/acl.js";

async function peek(request, cat) {
  // 記録用に、頼んだ中身の大きさとモデルだけを見る（本文そのものは残さない）
  try {
    if (cat === "transcribe") return { size: request.headers.get("content-length") || "" };
    if (request.method !== "POST") return {};
    const p = await request.clone().json();
    if (cat === "ai") {
      const res = (Array.isArray(p.resources) ? p.resources : []).reduce((n, r) => n + String((r && r.text) || "").length, 0);
      return { model: (Array.isArray(p.models) && p.models[0]) || p.model || "", chars: String(p.prompt || "").length + res };
    }
    if (cat === "tts") return { model: p.model || "", voice: p.voice || "", chars: String(p.text || "").length };
    if (cat === "image") return { model: p.model || "", chars: String(p.prompt || "").length };
  } catch (e) {}
  return {};
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const cat = categoryOf(request.method, url.pathname, url);
  if (!cat || !env.STATE) return context.next();

  const user = userOf(request);
  const admin = isAdmin(env, user);
  const config = admin ? null : await loadConfig(env);
  const pol = config ? policyFor(config, user) : null;

  // キーを渡すかどうか（数えない・記録しない）
  if (cat === "ai-key") {
    if (pol && !pol.directAI) return json({ ok: false, error: "このアカウントでは AI はサーバー経由で使います", viaServer: true }, 403);
    return context.next();
  }

  const t0 = Date.now();
  const detail = await peek(request, cat);
  const base = { user: user || "unknown", cat, path: url.pathname, method: request.method, ...detail };
  const log = (extra) => context.waitUntil(writeLog(env, { ...base, ...extra }).catch(() => {}));

  if (pol && LIMITABLE.includes(cat)) {
    const name = CATEGORIES[cat];
    if (pol.disabled.includes(cat)) {
      log({ status: 403, result: "止めた：使えない機能" });
      return json({ ok: false, error: `このアカウントでは「${name}」は使えません（管理者が止めています）`, limited: "disabled" }, 403);
    }
    if (!inHours(pol.hours)) {
      log({ status: 403, result: "止めた：時間帯の外" });
      return json({ ok: false, error: `このアカウントで使える時間は ${pol.hours.from}時〜${pol.hours.to}時（日本時間）です`, limited: "hours" }, 403);
    }
    const max = pol.limits[cat];
    if (Number.isInteger(max)) {
      const u = await getUsage(env, user);
      const used = u[cat] || 0;
      // 上限に達していても、すでに始まった操作の続き（3分以内の呼び出し）は最後まで通す
      if (used >= max && !isContinuation(u, cat)) {
        log({ status: 429, result: `止めた：上限（${used}/${max}）` });
        return json({ ok: false, error: `このアカウントの「${name}」は今日の上限（${max}回）に達しました（日本時間の0時に戻ります）`, limited: "count" }, 429);
      }
    }
  }

  let res;
  try {
    res = await context.next();
  } catch (e) {
    log({ status: 500, result: "エラー", ms: Date.now() - t0 });
    throw e;
  }
  const after = res.clone();
  context.waitUntil((async () => {
    // HTTP 200 でも中身が { ok:false } なら失敗として扱う（数えない）
    let ok = res.status >= 200 && res.status < 300, usedModel = "", note = "";
    if (/json/.test(after.headers.get("content-type") || "")) {
      try {
        const d = await after.json();
        usedModel = (cat === "ai" && d.model) || "";
        if (d.ok === false) { ok = false; note = String(d.error || "").slice(0, 120); }
      } catch (e) {}
    }
    let cont = false;
    if (ok && cat !== "save") cont = await addUsage(env, user || "unknown", cat, { chars: detail.chars }).catch(() => false);
    await writeLog(env, { ...base, status: res.status, result: ok ? (cont ? "成功（同じ操作の続き）" : "成功") : "失敗", ms: Date.now() - t0, usedModel, note }).catch(() => {});
  })());
  return res;
}
