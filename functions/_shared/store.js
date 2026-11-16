// ============================================================
// 作業の保存先をアカウントごとに分ける（2026-11-16 すみぽん「アカウントごとに保存先を分けて、手動で読み込むように」。
// 11/13 の作業が、AI のアカウントの 16 日の作業で上書きされたため）
// ・自分の保存先：R2 の u/<アカウント>/ の下（東証版 m/・p/・h/、米国版 us/）。書けるのは自分の保存先だけ。
// ・ほかのアカウントの保存と、分ける前の共有の保存（R2 の直下の m/・p/・h/・us/。名前は "_shared"）は、読むだけ（from=<名前>）。
// ・アカウントは Cloudflare Access のメールアドレス（acl.js の userOf）。ローカルは "local"。
// ============================================================
import { userOf } from "./acl.js";

export const SHARED = "_shared";
const OWNER_RE = /^[a-z0-9._@+\-]{1,120}$/;

export function ownerKey(user) {
  return String(user || "").toLowerCase().replace(/[^a-z0-9._@+\-]/g, "_").slice(0, 120);
}
export function myOwner(request) {
  return ownerKey(userOf(request));
}
const base = (owner) => (owner === SHARED ? "" : `u/${owner}/`);

// 頭に保存先を付けて読み書きする R2 の見かけ（list の key からは頭を外す）
export function scoped(bucket, owner) {
  const pre = base(owner);
  return {
    get: (k) => bucket.get(pre + k),
    put: (k, v, o) => bucket.put(pre + k, v, o),
    delete: (ks) => bucket.delete(Array.isArray(ks) ? ks.map((k) => pre + k) : pre + ks),
    async list(o) {
      const r = await bucket.list(Object.assign({}, o, { prefix: pre + (o.prefix || "") }));
      return Object.assign({}, r, { objects: r.objects.map((x) => ({ key: x.key.slice(pre.length), customMetadata: x.customMetadata, uploaded: x.uploaded, size: x.size })) });
    },
  };
}

// 読み書きする保存先を決める。読むときは from=<名前> でほかのアカウント・共有も読める。書くのは自分だけ
// 戻り値 { owner, me, bucket, readOnly } か、だめなら { error }
export function pick(context, write) {
  const me = myOwner(context.request);
  if (!me) return { error: "ログインしたアカウントが分かりません" };
  const from = new URL(context.request.url).searchParams.get("from") || "";
  if (from && from !== me) {
    if (write) return { error: "ほかのアカウント・共有の保存には書き込めません（読み込むだけ）" };
    if (from !== SHARED && !OWNER_RE.test(from)) return { error: "保存先の名前の形が違います" };
    return { owner: from, me, bucket: scoped(context.env.STATE, from), readOnly: true };
  }
  return { owner: me, me, bucket: scoped(context.env.STATE, me), readOnly: false };
}

// 保存のあるアカウントの一覧（自分以外も。共有は "_shared"）
export async function ownerList(bucket) {
  const out = [];
  let cursor;
  do {
    const r = await bucket.list({ prefix: "u/", delimiter: "/", cursor });
    for (const p of r.delimitedPrefixes || []) out.push(p.slice(2, -1));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

// 保存のあるアカウントごとの日の一覧（days は各 API の一覧の作り方）。自分を先頭、共有を最後に
export async function owners(bucket, me, days) {
  const names = (await ownerList(bucket)).filter((o) => o !== me);
  const out = [{ owner: me, me: true, days: await days(scoped(bucket, me)) }];
  for (const o of names.sort()) out.push({ owner: o, me: false, days: await days(scoped(bucket, o)) });
  const shared = await days(scoped(bucket, SHARED));
  if (shared.length) out.push({ owner: SHARED, me: false, shared: true, days: shared });
  return out.filter((x) => x.me || x.days.length);
}
