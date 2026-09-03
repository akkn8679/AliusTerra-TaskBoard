# Alius-Terra Task Board セットアップ / 運用メモ

このリポジトリは、Alius-Terra 開発用の共同タスク工程表です。

## 現在の構成

- Webアプリ: `index.html`
- 公開: GitHub Pages
- ログイン: Firebase Authentication（Google）
- データ保存: Firebase Realtime Database
- Database Path: `aliusTerraBoard`
- 担当者: `きむち / しぶ / いつ / いちご`

GoogleアカウントでFirebase Authenticationにログインできたユーザーは、タスクボードを利用できます。
タスク上の「担当者」はGoogleアカウントとは別で、ボード内の固定メンバー名から選択します。

---

## 1. Firebase Authentication

Firebase Consoleで次を設定します。

1. Alius-Terra用Firebaseプロジェクトを開く
2. `Authentication`
3. `Sign-in method`
4. `Google`
5. `Enable` をON
6. `Save`

GitHub Pages公開後は、Authenticationの `Settings` → `Authorized domains` にGitHub Pagesのドメインを追加します。

例:

```text
GitHub Pages URL
https://example.github.io/AliusTerra-TaskBoard/

Authorized domainsへ追加
example.github.io
```

URL全体ではなく、ドメイン部分だけを登録します。

---

## 2. Realtime Database Rules

Authentication動作確認後、Realtime Database → `Rules` を次のように設定します。

```json
{
  "rules": {
    "aliusTerraBoard": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

これにより、未ログインユーザーは `aliusTerraBoard` の読み書きができません。

---

## 3. GitHub Pages

GitHub上で:

1. `AliusTerra-TaskBoard` リポジトリを開く
2. `Settings`
3. `Pages`
4. `Build and deployment`
5. Source: `Deploy from a branch`
6. Branch: `main`
7. Folder: `/(root)`
8. `Save`

公開後に表示されるURLをメンバーへ共有します。

---

## 4. 初回動作確認

1. GitHub Pages URLをChromeで開く
2. `Googleでログイン` を押す
3. Googleアカウントを選択する
4. 必要なら「あなたは誰ですか？」でボード上の担当者名を選ぶ
5. 既存タスクが表示されることを確認
6. 新しいタスクを1件追加
7. Firebase Console → Realtime Database → Data で反映を確認
8. 別ブラウザまたは別端末でも同じURLを開き、リアルタイム同期を確認

---

## 5. HTMLを変更したときの運用

1. VS Codeで `index.html` を編集
2. GitHub DesktopでDiff確認
3. Unityとは無関係なので、タスクボード用リポジトリだけをCommit
4. `Push origin`
5. GitHub Pagesへ自動反映
6. 公開URLで動作確認

Firebase上のタスク追加・進捗変更・履歴追加はGitの変更にはなりません。
GitHubはWebアプリ本体を管理し、Firebaseは共同編集データを管理します。

---

## 6. 役割の整理

```text
VS Code
  └─ index.htmlを編集
       ↓
GitHub Desktop
  └─ Commit / Push
       ↓
GitHub Repository
  └─ Webアプリのソースコード
       ↓
GitHub Pages
  └─ みんながアクセスするURL
       ↓
Firebase Authentication
  └─ Googleログイン
       ↓
Realtime Database Rules
  └─ ログイン済みか判定
       ↓
Realtime Database
  └─ tasks / history / milestones などを保存
```
GitHub Pages deployment enabled.