// ============================================================
// /api/admin（2026-11-13）：アカウントの制限の設定と、使った回数・記録を見る（管理画面 admin.html 用）
//   GET  /api/admin                … 自分・管理者・設定・今日の各アカウントの回数・記録のある日付
//   GET  /api/admin?log=YYYY-MM-DD … その日の記録（新しい順、最大500件）
//   GET  /api/admin?me=1           … 自分が管理者かどうかだけ（{ ok, admin }。誰でも呼べる。設定タブに管理画面への入口を出すかどうかを決める）
//   PUT  /api/admin                … 設定を保存（本文は { users: {メール: {...}}, default: {...} }）
// 開けるのは環境変数 ADMIN_EMAILS に入っている人と、ローカルだけ。
// ============================================================
import {
  CATEGORIES, LIMITABLE, KEEP_LOG_DAYS, json, userOf, adminList, canAdmin, loadConfig, cleanConfig,
  jstDate, readLogs, logDates, cleanupOld,
} from "../_shared/acl.js";

function guard(context) {
  const { request, env } = context;
  const user = userOf(request);
  if (!env.STATE) return { res: json({ ok: false, error: "R2（STATE）が紐づいていません" }, 503) };
  if (!canAdmin(env, user)) {
    const why = adminList(env).length
      ? "このアカウントは管理者ではありません"
      : "管理者が決まっていません（Cloudflare の環境変数 ADMIN_EMAILS に管理者のメールアドレスを入れてください）";
    return { res: json({ ok: false, error: why, me: user }, 403) };
  }
  return { user };
}

export async function onRequestGet(context) {
  if (new URL(context.request.url).searchParams.get("me")) {
    const { request, env } = context;
    return json({ ok: true, admin: !!env.STATE && canAdmin(env, userOf(request)) });
  }
  const g = guard(context);
  if (g.res) return g.res;
  const { env, request } = context;
  const url = new URL(request.url);
  const logDate = url.searchParams.get("log");
  if (logDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) return json({ ok: false, error: "日付の形が違います" }, 400);
    return json({ ok: true, date: logDate, logs: await readLogs(env, logDate) });
  }
  context.waitUntil(cleanupOld(env).catch(() => {}));
  const config = await loadConfig(env);
  const today = jstDate();
  // 今日の回数（記録のあるアカウントすべて）
  const usage = {};
  const r = await env.STATE.list({ prefix: `acl/usage/${today}/` });
  await Promise.all(r.objects.map(async (o) => {
    const email = decodeURIComponent(o.key.slice(`acl/usage/${today}/`.length).replace(/\.json$/, ""));
    try { usage[email] = JSON.parse(await (await env.STATE.get(o.key)).text()); } catch (e) {}
  }));
  return json({
    ok: true, me: g.user, admins: adminList(env), config, today, usage,
    dates: await logDates(env), categories: CATEGORIES, limitable: LIMITABLE, keepDays: KEEP_LOG_DAYS,
  });
}

export async function onRequestPut(context) {
  const g = guard(context);
  if (g.res) return g.res;
  let body;
  try { body = await context.request.json(); } catch (e) { return json({ ok: false, error: "本文を読めませんでした" }, 400); }
  const config = cleanConfig(body);
  await context.env.STATE.put("acl/config.json", JSON.stringify(config, null, 2), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, config });
}
