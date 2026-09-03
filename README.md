# Alius-Terra Task Board セットアップ

このフォルダは、元の共同開発用タスク工程表を Alius-Terra 用に分離したものです。

## 1. メンバー名を設定

`index.html` の `APP_CONFIG` を編集します。

```js
const APP_CONFIG = {
  projectTitle: 'Alius-Terra｜開発工程表',
  projectSubtitle: 'アリウステラ 共同編集ボード／タスクを右クリックすると詳細を編集できます',
  members: ['きむち', 'しぶ', 'いつ', 'いちご'],
  databasePath: 'aliusTerraBoard',
};
```

この配列に、タスクボードを利用するメンバー名を設定します。

## 2. Alius-Terra 専用 Firebase プロジェクトを作る

1. Firebase Console で新規プロジェクトを作成。
2. Realtime Database を作成。
3. Web アプリを追加。
4. 表示された `firebaseConfig` の値を `index.html` の `FIREBASE_CONFIG` に貼り付け。

このHTMLは Firebase Realtime Database の `aliusTerraBoard` 配下だけを使用します。

### 初回動作確認用ルール

まず3人で接続確認をするだけなら、Realtime Database の Rules を次のようにできます。

```json
{
  "rules": {
    "aliusTerraBoard": {
      ".read": true,
      ".write": true
    }
  }
}
```

**注意:** このルールはURLを知っている第三者からの読み書きも許可します。動作確認後は Firebase Authentication を導入して認証済みメンバーだけに制限するのがおすすめです。

## 3. Firebase 設定を貼り付ける

`index.html` の下記部分を自分のプロジェクト値で置き換えます。

```js
const FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  databaseURL: 'https://YOUR_DATABASE_NAME.REGION.firebasedatabase.app',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
```

Firebase の Web 用 config 自体はブラウザアプリから見える前提の識別情報です。データ保護は Realtime Database Rules / Authentication / App Check で行います。

## 4. ローカルで確認

VS Code でこのフォルダを開き、Live Server 等のローカルHTTPサーバーで `index.html` を開きます。

Firebase接続後、別ブラウザまたは別端末から同じページを開き、片方で追加したタスクがもう片方にも反映されれば同期成功です。

## 5. GitHub に置く

おすすめ構成:

```text
AliusTerra/
  TaskBoard/
    index.html
    README.md
```

既存の `AliusTerra` リポジトリで管理する場合は、この `TaskBoard` フォルダを追加して Commit / Push します。

Unityプロジェクトのリポジトリ直下に置く場合も、HTMLはUnityの `Assets` 配下ではなく、Unityプロジェクト外の `TaskBoard` フォルダに置く方が整理しやすいです。

## 6. GitHub Pages で共有URLを作る

GitHub Pages を使うなら、Pages の公開元にできる場所へHTMLを置きます。簡単なのは専用リポジトリに `index.html` を置いて `/ (root)` から公開する方法です。

既存の巨大なUnityリポジトリから Pages を公開するより、`AliusTerra-TaskBoard` のような小さな専用リポジトリに分離する方がおすすめです。タスクボードの更新履歴とゲーム本体の履歴も混ざりません。

GitHub で:

1. リポジトリ → Settings
2. Pages
3. Build and deployment → Source → Deploy from a branch
4. Branch を `main`
5. Folder を `/(root)`
6. Save

公開後に表示される GitHub Pages URL を3人で共有します。

## 7. 運用上のおすすめ

- ゲーム本体: `AliusTerra` リポジトリ
- タスク工程表: `AliusTerra-TaskBoard` リポジトリ
- データ: Alius-Terra 専用 Firebase Realtime Database

この3つを分離すると、Unity本体・工程表Webアプリ・タスクデータの責務が混ざりません。

## 8. 次にやると安全なこと

初回同期が成功したら、Firebase Authentication を追加して3人だけが読み書きできるルールに変更してください。
