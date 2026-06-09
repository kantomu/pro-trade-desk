# Trade Desk — GitHub Pages 完成版（3時間ごと自動更新・インストール型PWA）

GitHub Actions が3時間ごとにデータを取得して `public/data.json` を作り、
GitHub Pages が配信。アプリは静的ファイルを読むだけなので**速くて落ちにくい**。

## ソースが破綻しない工夫（耐障害設計）
- **前回値の保持**：実行ごとに「直近の公開データ」を基準に読み込み、**成功したソースだけ上書き**。FMPやAIが一時的に落ちても、**前回の最新値を維持**（空白化しない）。
- **リトライ**：各取得を最大3回まで自動再試行。
- **個別フェイルセーフ**：COTは銘柄ごと、価格は銘柄ごとに失敗を切り離し、取れた分だけ更新。
- **鮮度の記録と警告**：`freshness` に各セクションの取得時刻を保存。画面は古い（約6時間超）と「データが古い可能性」を警告表示。
- **AIのタイムアウト回避**：GitHub Actionsは実行時間制限が緩く、分析生成が60秒制限に引っかからない（Vercel無料の弱点を解消）。
- **3時間ごとcron**：無料で確実（Vercel無料の「1日1回」制限が無い）。

## 構成
```
/fetch-data.js               … 3時間ごとに動く取得スクリプト（耐障害）
/package.json
/.github/workflows/update.yml … cron(3h)+手動、Pagesへデプロイ
/public/
  index.html                 … PWA本体（./data.json を読む）
  data.json                  … 初期データ（前回値の最初の基準）
  manifest.webmanifest / sw.js / icon.svg … PWA一式
```

## 既存リポジトリ（kantomu/trade-desk）への切替手順

1. このフォルダの中身を**そのままアップロード**（GitHub: Add file → Upload files。`public` と `.github/workflows` のフォルダ構造を保つ）。
   - 既存のVercel用ファイル（`api/`・`vercel.json`・ルートの `index.html`）は**残してもPagesは無視**します。混乱を避けるなら削除可。
2. **Settings → Secrets and variables → Actions** で登録：
   - `FMP_API_KEY`（無料）
   - `ANTHROPIC_API_KEY`（任意・分析文用）
3. **Settings → Pages** → Source を **「GitHub Actions」** に設定。
4. **Actions** タブ → 「Update Trade Desk」→ **Run workflow** で初回実行。
5. 数分後、**`https://kantomu.github.io/trade-desk/`** が公開。スマホで開き「**ホーム画面に追加**」＝インストール完了。

> 以降は **3時間ごとに自動更新**（cron `0 */3 * * *`）。手動更新は Actions の Run workflow。

### Vercelについて（任意）
リポジトリがVercelに連携されたままだと、アップロードのたびにVercel側も再デプロイされます（害はありません）。不要なら Vercel のプロジェクトを削除、または Vercel側でGit連携を解除すれば止まります。Pagesの動作には影響しません。

## 更新頻度の変更
`.github/workflows/update.yml` の cron を編集：
- 3時間ごと（既定）: `0 */3 * * *`
- セッション連動（東京/ロンドン/NY前・平日, UTC）: `0 22,7,12 * * 1-5`

## メモ
- 取得不可ソース（MUFG銀行PDF・TradersWeb）は対象外。FMP/CFTC/算出＋AI解釈で構成。
- 出力は判断材料であり売買助言ではありません。
