// ============================================================
// CF Pages Function: /api/image
// Gemini の画像生成モデルで画像を作る。
// ・APIキーは環境変数 GEMINI_API_KEY からサーバー側でのみ読む
// ・無料枠では画像モデルの割当が0のため、課金(有料枠)有効化後に動く
// ============================================================

const MODEL = "gemini-2.5-flash-image";
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
    return json({ ok: false, error: "APIキーが未設定です（.dev.vars / CF環境変数の GEMINI_API_KEY）" }, 400);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: "リクエストの解析に失敗しました" }, 400); }

  const prompt = (payload && payload.prompt || "").trim();
  if (!prompt) return json({ ok: false, error: "prompt が空です" }, 400);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };

  try {
    const res = await fetch(ENDPOINT(payload.model || MODEL, key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const raw = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      // 課金未有効化(無料枠割当0)の 429 を分かりやすく案内
      let msg = raw;
      if (res.status === 429 && /limit:\s*0|free_tier/i.test(raw)) {
        msg = "画像生成は無料枠では利用できません。Google Cloudで課金(有料枠)を有効化すると動作します。（元のエラー: " + raw.slice(0, 120) + "…）";
      }
      return json({ ok: false, error: msg, status: res.status, needsBilling: res.status === 429 }, 502);
    }
    const part = (data.candidates && data.candidates[0] && data.candidates[0].content &&
                  data.candidates[0].content.parts || []).find((p) => p.inlineData);
    if (!part) {
      return json({ ok: false, error: "画像データが返りませんでした" }, 502);
    }
    return json({ ok: true, mimeType: part.inlineData.mimeType || "image/png", dataBase64: part.inlineData.data });
  } catch (e) {
    return json({ ok: false, error: "呼び出し失敗: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}
