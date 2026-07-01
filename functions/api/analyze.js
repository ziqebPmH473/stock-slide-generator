// ============================================================
// CF Pages Function: /api/analyze
// Gemini API を呼び出す汎用エンドポイント。
// ・APIキーは環境変数 GEMINI_API_KEY からサーバー側でのみ読む
//   （ローカル: .dev.vars / 本番: CF Pages の環境変数）
// ・ブラウザからは prompt と（任意で）resources を受け取るだけ
// ============================================================

const MODEL = "gemini-2.5-flash";
const ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const key = env.GEMINI_API_KEY;
  if (!key || key === "xxxxx") {
    return json({ ok: false, error: "APIキーが未設定です（.dev.vars の GEMINI_API_KEY を設定してください）" }, 400);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: "リクエストの解析に失敗しました" }, 400); }

  const prompt = (payload && payload.prompt || "").trim();
  if (!prompt) return json({ ok: false, error: "prompt が空です" }, 400);

  // resources: 参考資料テキスト（URL取得結果や銘柄名一覧表など）を配列で渡せる
  const resources = Array.isArray(payload.resources) ? payload.resources : [];
  const resourceText = resources
    .map((r) => `【${r.label || "資料"}】\n${r.text || ""}`)
    .join("\n\n");

  const fullPrompt = resourceText
    ? `以下の資料のみを根拠として、指示に厳密に従って回答してください。資料に無い情報を創作しないでください。\n\n===== 資料 =====\n${resourceText}\n\n===== 指示 =====\n${prompt}`
    : prompt;

  const body = {
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.4,
    },
  };

  try {
    const res = await fetch(ENDPOINT(payload.model || MODEL, key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      return json({ ok: false, error: "Gemini API エラー: " + msg }, 502);
    }
    const text =
      (data.candidates && data.candidates[0] && data.candidates[0].content &&
       data.candidates[0].content.parts || [])
        .map((p) => p.text || "").join("").trim();
    const usage = data.usageMetadata || null;
    return json({ ok: true, text, usage, model: payload.model || MODEL });
  } catch (e) {
    return json({ ok: false, error: "呼び出し失敗: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok: true, hint: "POST {prompt, resources?} を送ってください" });
}
