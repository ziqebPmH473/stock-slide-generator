# 決算のキー（FINNHUB_API_KEY）を東証ツールに登録する

米国版の決算一覧表では、決算の予想と実績（EPS・売上）と発表の時間（寄り前・引け後）を Finnhub から取る（`/api/us-sources?part=earnings`）。キーが無いと、売上の予想・実績と EPS の実績が入らず、寄り前か引け後かもわからない（EPS の予想だけは Nasdaq から入る）。

登録先は2か所：本番の Cloudflare と、手元のパソコン（ローカルで試すとき・天気の基準を分析するとき）。

## 1. キーを用意する

- Claude のクラウドの環境「stock-slide-generator」に登録したキーと同じものでよい（手元に控えがあればそれを使う）。
- 控えが無ければ、https://finnhub.io/dashboard を開いてログインする。画面の「API Key」に出ている文字列をコピーする（無料のキー。何度でも見られる）。
  - アカウントが無ければ、https://finnhub.io/register で作る（無料）。

## 2. Cloudflare に登録する

1. https://dash.cloudflare.com/ を開き、左のメニューの「コンピューティング（Workers）」→「Workers & Pages」を開く。
2. 一覧から、東証ツールのプロジェクト（ふだん開いている東証ツールの URL `〜.pages.dev` と同じ名前のもの）を開く。
   - kessan-tool や kessan-visualizer と間違えないこと。
3. 「設定」タブ →「変数とシークレット」→「追加」を押す。
4. 次のとおり入力して保存する。
   - 種類：`シークレット`
   - 変数名：`FINNHUB_API_KEY`
   - 値：1. のキー
   - 環境：`本番（Production）`

## 3. 手元のパソコンに登録する

1. エクスプローラーで `C:\work\stock-slide-generator` を開き、`.dev.vars` をメモ帳で開く（ファイルが見えなければ、エクスプローラーの「表示」→「表示」→「隠しファイル」にチェック）。
2. いちばん下に次の1行を足して保存する（`xxxxx` を 1. のキーに置き換える）。

```
FINNHUB_API_KEY=xxxxx
```

- `.dev.vars` は Git に入らない（キーは外に出ない）。

## 4. 完了したら

チャットで「FINNHUB_API_KEY を Cloudflare と .dev.vars に登録した」と伝える。こちらで次のことをする。

- 再デプロイして、本番から `/api/us-sources` を呼び、Yahoo・日経・Nasdaq・Finnhub が取れるか確かめる（Yahoo が Cloudflare から弾かれないか）。
- 手元で決算一覧の寄り前／引け後の分け方と天気を確かめる。
- 天気の基準の分析（`docs/design/2026-11-13_米国版_決算の反応の分析/`）を最後まで行う。
