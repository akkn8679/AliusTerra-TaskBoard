# Discord管理ログ通知

作業履歴の「未登録」ボタン → Firebaseの `aliusTerraBoard/historyDiscordQueue/<履歴IDと内容のハッシュ>` → Cloudflare Cron → Discordの管理ログ、という構成です。配信結果は同じボード内の `historyDiscordReceipts` に保存します。FirebaseはSparkを維持します。Unity側の変更はありません。

## 投稿の仕様

- 各履歴の右端に「未登録／登録済み」を表示します。ROVERと同じく青は未登録、緑は登録済みです。「未登録」を押すと、現在の内容を投稿用に登録します。登録済みの説明には、送信待ちかDiscordから成功応答が返った配信済みかを表示します。
- Enter・blur・通常の自動保存、担当者・作業日の変更、削除ではDiscordへ投稿しません。日本語変換中や作業内容が空欄の場合は登録できません。
- 作業内容・作業ブランチ・担当者・作業日が登録時の内容と異なると「未登録」に戻ります。再登録ボタンを押すまで編集内容を投稿しません。登録状態はFirebaseの通知スナップショットと配信結果から判定し、再読み込み・他の端末でも共有します。
- タスクを完了、不具合を解決済み、議題を解決済みにした時は、完了内容を作業履歴へ追加して自動通知します。作成した履歴の `completionSnapshot` を固定し、同じ項目を再度完了にしても二重通知しません。導入前に完了していた項目は一括通知しません。
- 約1分ごとに最大5件を確認します。同じ履歴・同じ内容は同じハッシュとなり、再登録しても二重投稿しません。登録後の未登録の編集は送信内容に反映しません。履歴を削除しても、保存済みの登録スナップショットは残ります。
- 投稿には作業内容、担当者、作業ブランチ、作業日、通知IDを表示します。Googleメールアドレス、Googleの認証識別子や認証トークンは投稿しません。
- 導入前の履歴は「未登録」として表示し、ボタンを押すまで投稿しません。以前の自動投稿と同じ内容でも、最初の手動登録は1回投稿します。
- 通知の `trigger: "manual"` を検証するため、古いHTMLを開いたままの端末による自動通知は送信しません。
- 同じ確定内容、同じ通知IDは再投稿しません。既送信状態はSQLiteのDurable Objectへ保存します。
- Discordの成功応答を確認してから送信済みとします。429は指定時間を待って再試行します。受理されたか不明な通信切断や中断は「要確認」とし、二重投稿を防ぐため自動再送しません。ブラウザを閉じてもFirebase保存済みの通知は処理されます。
- 旧ページの `historyNotifications` も引き続き読み取ります。旧Durable Objectの送信済み台帳と一致する通知は、新しい配信結果へ引き継いで再送しません。旧方式そのものは従来の再試行動作を維持するため、メンバーにはページの再読み込みを案内してください。
- 3500文字を超える作業内容は末尾を省略し、ボードへのリンクを表示します。`@everyone`等のメンション通知は無効です。

## 初回設定

初期設定は `NOTIFICATIONS_ENABLED: "false"` です。接続先を確認するまで投稿しません。秘密はHTML・Git・チャットへ貼らず、CloudflareのSecretへ直接入力します。

1. Discordのアリウステラサーバーで**管理ログチャンネル**を開き、チャンネルの設定 → 連携サービス → ウェブフックから専用Webhookを作成します。表示される投稿先のサーバー・チャンネルを確認します。Webhook URLが投稿先を指定するのでサーバーID・チャンネルIDの公開設定は不要です。
2. Google Cloudの `aliusterratasks` プロジェクトで通知用サービスアカウントを用意します。従来のViewerだけでは、新方式の配信結果保存と完了履歴の受付確認を書き込めません。配信結果・通知キューの書き込み、および履歴の `autoRegister` の解除ができる認可を確認してください。Workerのコードは既存ボード内の通知関連パス以外へ書き込みません。既存のAdmin SDKアカウントは使い回しません。

   現行環境では、ユーザーの明示承認を受けて専用アカウントに標準の `roles/firebasedatabase.admin` を付与し、実際の送信と配信結果の保存を確認しています。この標準ロールにはデータベースの作成・削除権限も含まれます。Worker側では通知関連パスと完了フラグの解除だけを許可し、DBの作成・削除APIは呼びません。

   既存のViewerとカスタムロール `projects/aliusterratasks/roles/aliusTerraDiscordDeliveryWriter` も保持しています。カスタムロールは既存Viewer相当の読み取り権限と `firebasedatabase.instances.update` で構成しています。導入時には、このカスタムロールがIAM診断上は許可されても実際のREST書き込みは401を返しました。標準ロール追加後は成功しています。標準ロールを外して運用できるかは未検証のため、外す場合は配信結果の保存まで再確認してください。
3. この専用アカウントのJSON鍵を取得し、Cloudflareの `FIREBASE_SERVICE_ACCOUNT` SecretとしてJSON全文を保存します。鍵は公開リポジトリの外で扱います。
4. `discord/` で `npm ci` を実行し、`npx wrangler login` でCloudflareの公開用ログインを済ませます。
5. `npm run check` → `npm run deploy`。Worker名は `aliusterra-discord-history`。SQLite Durable Objectと毎分Cronは設定ファイルから作成されます。`workers.dev`とプレビューURLは無効です。
6. Cloudflare → Workers & Pages → `aliusterra-discord-history` → Settings → Variables and Secrets に以下を設定します。

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `DISCORD_WEBHOOK_URL` | 管理ログ専用Webhook URL |
| Secret | `FIREBASE_SERVICE_ACCOUNT` | 専用サービスアカウントのJSON全文 |
| Variable | `NOTIFICATIONS_ENABLED` | 接続確認後に文字列 `true` |

7. フロントの `index.html` をGitHub Pagesへ反映します。既存ルールがREADME記載の `aliusTerraBoard` 全体に対するログイン済みアクセスであれば、新しい通知パスも同じ認証で保存できます。実際のルールが異なる場合は `historyDiscordQueue` に履歴と同等の認証・書き込み検証、`historyDiscordReceipts` にログイン済みの読み取り権限を適用してください。ルールを未認証公開に変更してはいけません。新しい検索indexは必要ありません。
8. テスト履歴を1件追加し、内容を入力して右端の「未登録」を押します。緑に切り替わり、約1分後に管理ログへ投稿され、ボタンの説明が投稿済みへ変わることを確認します。編集時に「未登録」へ戻り、再登録時だけ更新内容を投稿することも確認します。さらに新しい項目を完了して自動履歴と自動通知を確認します。Cronの初回反映には数分かかる場合があります。

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

CloudflareのWorkerログ・Cronイベントで実行成功を確認します。Firebase接続失敗や429は再試行します。Discordの送信結果が不明な場合は管理ログを照合し、未送信を確認してから対応してください。`NOTIFICATIONS_ENABLED` を `false` にすれば停止できます。停止中に受付済みになった通知は再開後に処理されます。

ローカル実行は `npm run dev`。通知無効状態で `http://localhost:8787/__scheduled?cron=*+*+*+*+*` を開き、Cronハンドラーを確認できます。公開HTTPから投稿を起動するAPIはありません。

## 運用上の境界

新方式は履歴と内容のハッシュごとにキュー・配信結果を保持します。`historyNotifications` は旧方式との互換用に保持します。長期運用で件数が大量に増えた場合は、送信済み台帳と照合した保管・整理を別途行ってください。通信量は履歴件数に比例します。

導入後はメンバーにページの再読み込みを依頼してください。古いHTMLによる自動通知は新しいWorkerで無視されます。投稿時刻は登録時刻です。操作したメンバー欄は既存の担当者選択名で、Googleアカウントによる監査証明ではありません。

## 公式資料

- [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [SQLite Durable Objectsの無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Firebase REST認証](https://firebase.google.com/docs/database/rest/auth)
- [Firebase Realtime Database Viewer](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasedatabase)
- [Discord Webhook](https://docs.discord.com/developers/resources/webhook)
