# 文字起こしのキー（GROQ_API_KEY）を東証ツールに登録する

⑥動画の読み上げを場面ごとに正しく切るため、kessan-tool と同じ文字起こし（Groq の Whisper）を使う。東証ツールの Cloudflare にキーを登録する。

## 1. キーを用意する

- kessan-tool で使っている Groq のキーと同じものでよい（手元に控えがあればそれを使う）。
- 控えが無ければ新しく作る：https://console.groq.com/keys を開く → 「Create API Key」→ 名前は `stock-slide-generator` → 作成。
  - **キーは作成した画面で1回しか表示されない。** すぐにコピーしておく。

## 2. Cloudflare に登録する

1. https://dash.cloudflare.com/ を開き、左のメニューの「コンピューティング（Workers）」→「Workers & Pages」を開く。
2. 一覧から、東証ツールのプロジェクト（ふだん開いている東証ツールの URL `〜.pages.dev` と同じ名前のもの）を開く。
   - kessan-tool や kessan-visualizer と間違えないこと。
3. 「設定」タブ →「変数とシークレット」→「追加」を押す。
4. 次のとおり入力して保存する。
   - 種類：`シークレット`
   - 変数名：`GROQ_API_KEY`
   - 値：1. のキー
   - 環境：`本番（Production）`

## 3. 完了したら

チャットで「東証ツールに GROQ_API_KEY を登録した」と伝える。こちらで再デプロイし、⑥動画の「読み上げを作る」で文字起こしが使われているか確認する。

キーが無いあいだは、文字数の見当と無音で切り分ける（今までどおり）。
