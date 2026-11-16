# このリポジトリで作業するときの決まり

## 本番に出す（2026-11-16 すみぽん）

- 変更は確認を取らずに `main` に出してよい（すみぽんは本番でしか確認しないため）。`main` に push すると GitHub Actions（`.github/workflows/deploy.yml`）が Cloudflare Pages に出す。

## 版の表示（2026-11-16 すみぽん）

- 画面右上に `v日付-時間`（例：`v20261116-1840`、日本時間）を出している。デプロイで `index.html` の `__SSG_VERSION__` が、`main` の最新コミットの日時に置き換わる（手で書き換えない）。
- **更新して `main` に出したら、必ずチャットでもその版を書く。**
  版は `main` に出したあと `TZ=Asia/Tokyo git log -1 origin/main --format=%cd --date=format-local:%Y%m%d-%H%M` で出し、`v` を付けて書く（例：「本番の版：v20261116-1840」）。
