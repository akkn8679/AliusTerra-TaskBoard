# Discord管理ログ通知

作業履歴の確定保存 → Firebaseの `aliusTerraBoard/historyNotifications/<履歴ID>` → Cloudflare Cron → Discordの管理ログ、という構成です。FirebaseはSparkを維持します。Unity側の変更はありません。

## 投稿の仕様

- 作業内容・分類の入力はEnter（IME確定用Enterを除く）またはblurで確定したときに通知を記録します。
- 担当者・作業日は選択を変更したとき、削除は削除操作時に記録します。
- 履歴と通知スナップショットは同じFirebase更新で保存します。入力途中の自動保存は通知しません。
- 約1分ごとの確認で、同じ履歴の短時間の変更を最新の確定内容にまとめます。すべての中間編集を保存する監査ログではありません。保存後すぐ削除した場合は削除通知にまとまります。
- 投稿には作業内容、担当者、分類、作業日、操作したメンバー（ボード上の選択名）、通知IDを表示します。Googleメールアドレスや認証トークンは投稿しません。
- 未使用の空欄履歴は投稿しません。既に投稿した履歴の内容を空欄にした変更や削除は投稿します。
- 導入前の過去履歴を通知キューへ移行しないため、導入だけで過去履歴が大量投稿されることはありません。
- 同じ確定内容、同じ通知IDは再投稿しません。既送信状態はSQLiteのDurable Objectへ保存します。
- Discordの成功応答を確認してから送信済みとします。失敗・429は次回以降のCronで再試行し、最大10件ずつ送ります。ブラウザを閉じてもFirebase保存済みの通知は処理されます。
- Discordが受理した直後に通信が途切れた場合や送信済み保存前に実行が中断された場合は、再試行で重複する可能性があります。通知IDで識別できます。
- 3500文字を超える作業内容は末尾を省略し、ボードへのリンクを表示します。`@everyone`等のメンション通知は無効です。

## 初回設定

初期設定は `NOTIFICATIONS_ENABLED: "false"` です。接続先を確認するまで投稿しません。秘密はHTML・Git・チャットへ貼らず、CloudflareのSecretへ直接入力します。

1. Discordのアリウステラサーバーで**管理ログチャンネル**を開き、チャンネルの設定 → 連携サービス → ウェブフックから専用Webhookを作成します。表示される投稿先のサーバー・チャンネルを確認します。Webhook URLが投稿先を指定するのでサーバーID・チャンネルIDの公開設定は不要です。
2. Google Cloudの `aliusterratasks` プロジェクトで通知用サービスアカウントを作成し、`Firebase Realtime Database Viewer` (`roles/firebasedatabase.viewer`) を付与します。専用の読み取り権限を使い、既存のAdmin SDKアカウントは使い回しません。
3. この専用アカウントのJSON鍵を取得し、Cloudflareの `FIREBASE_SERVICE_ACCOUNT` SecretとしてJSON全文を保存します。鍵は公開リポジトリの外で扱います。
4. `discord/` で `npm ci` を実行し、`npx wrangler login` でCloudflareの公開用ログインを済ませます。
5. `npm run check` → `npm run deploy`。Worker名は `aliusterra-discord-history`。SQLite Durable Objectと毎分Cronは設定ファイルから作成されます。`workers.dev`とプレビューURLは無効です。
6. Cloudflare → Workers & Pages → `aliusterra-discord-history` → Settings → Variables and Secrets に以下を設定します。

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `DISCORD_WEBHOOK_URL` | 管理ログ専用Webhook URL |
| Secret | `FIREBASE_SERVICE_ACCOUNT` | 専用サービスアカウントのJSON全文 |
| Variable | `NOTIFICATIONS_ENABLED` | 接続確認後に文字列 `true` |

7. フロントの `index.html` をGitHub Pagesへ反映します。既存ルールがREADME記載の `aliusTerraBoard` 全体に対するログイン済みアクセスであれば、新しい通知パスも同じ認証で保存できます。実際のルールが異なる場合は `historyNotifications` に履歴と同等の認証・書き込み検証を適用してください。ルールを未認証公開に変更してはいけません。
8. 管理ログで実投稿を確認するテスト履歴を1件追加し、Enterで確定します。約1分後、内容と投稿先を確認します。その後に編集と削除を確認します。Cronの初回反映には数分かかる場合があります。

後日CLIから再公開するときも `NOTIFICATIONS_ENABLED` を明示して有効化してください。設定ファイルは初回誤送信防止のため `false` を維持しています。

```powershell
npx wrangler deploy --var NOTIFICATIONS_ENABLED:true
```

## 確認と停止

```powershell
cd discord
npm test
npm run check
```

CloudflareのWorkerログ・Cronイベントで実行成功を確認します。接続失敗時は投稿を既送信にせず再試行します。`NOTIFICATIONS_ENABLED` を `false` にすれば停止できます。停止中の各履歴の最新確定内容は再開後に送信されます。

ローカル実行は `npm run dev`。通知無効状態で `http://localhost:8787/__scheduled?cron=*+*+*+*+*` を開き、Cronハンドラーを確認できます。公開HTTPから投稿を起動するAPIはありません。

## 運用上の境界

`historyNotifications` は各履歴の最新確定スナップショットを1件保持します（削除済み履歴も含む）。過去通知を無制限に追記する方式ではありません。長期運用で履歴IDが大量に増えた場合は、送信済み状態と照合した保管・整理を別途行ってください。通信量は履歴件数に比例します。

古いHTMLを開いたままの端末は通知情報を作成しません。導入後はメンバーにページの再読み込みを依頼してください。投稿時刻は確定保存時刻です。操作したメンバー欄は既存の担当者選択名で、Googleアカウントによる監査証明ではありません。

## 公式資料

- [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [SQLite Durable Objectsの無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Firebase REST認証](https://firebase.google.com/docs/database/rest/auth)
- [Firebase Realtime Database Viewer](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasedatabase)
- [Discord Webhook](https://docs.discord.com/developers/resources/webhook)
