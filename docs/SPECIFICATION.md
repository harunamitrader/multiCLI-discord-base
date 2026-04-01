# 仕様書

## 1. 概要

Codex Discord Connected Display は、1つの Codex CLI セッションを

- ローカル UI
- Discord の指定チャンネル

から共有して使うためのローカル bridge アプリです。略称は `CoDiCoDi` です。

現在は次の 2 形態で利用できます。

- Node.js のローカルアプリ + ブラウザ UI
- Tauri デスクトップアプリ

## 2. 現在の目的

現時点の主な目的は次の通りです。

- ローカル UI と Discord の両方から同じ Codex セッションを継続できること
- セッション管理を分かりやすくすること
- 文章、画像、ファイル添付に対応すること
- 進捗や途中メッセージを表示すること
- ローカル完結に近い軽量構成にすること

## 3. 非目的

現時点では次は目指していません。

- 公開 SaaS
- 多人数向け共有サービス
- インターネット公開前提の構成
- 企業向けの厳格なセキュリティ製品

## 4. 構成要素

### 4.1 server

場所:

- `server/src`

役割:

- `.env` の読み込み
- SQLite 保存
- Codex CLI の起動
- UI への SSE 配信
- Discord 連携
- 添付ファイル保存
- ファイル監視
- スケジュール実行
- 開発者コンソール用ログ出力

### 4.2 ui

場所:

- `ui`

役割:

- セッション一覧表示
- アクティブセッション表示
- メッセージ送信
- 添付ファイル選択
- drag & drop / paste 添付
- 進捗表示
- セッション設定変更
- スケジュール設定変更
- working directory 選択
- 開発者コンソール起動

### 4.3 src-tauri

場所:

- `src-tauri`

役割:

- bridge の自動起動
- 起動中スプラッシュ表示
- 専用ウィンドウでの UI 表示
- 自分で起動した child bridge の終了処理
- 起動前の残留 bridge process 整理
- close 確認ダイアログ

## 5. 基本概念

### 5.1 セッション

セッションは 1 つの継続会話単位です。

各セッションは主に次の情報を持ちます。

- セッション ID
- セッション名
- 現在の状態
- Codex thread ID
- Discord チャンネル紐付け
- model
- reasoning effort
- profile
- service tier / fast mode
- working directory

### 5.2 イベント

セッション履歴はイベントとして保存します。

例:

- ユーザーメッセージ
- assistant メッセージ
- コマンド開始表示
- status 変更
- エラー

### 5.3 共有セッション

ローカル UI と Discord は別会話を持つのではなく、同じセッションに対して入力を流します。

## 6. 現在対応している機能

### 6.1 セッション管理

- 新規作成
- 名前変更
- 削除
- DB からの会話復元
- stale session の復旧
- Discord チャンネル紐付け
- セッションごとの working directory 切り替え

### 6.2 スケジュール管理

- cron 形式の定期実行
- 既存セッション宛て送信
- 新規セッション生成での送信
- スケジュール既定 model / reasoning / profile / workdir 保存
- スケジュール一覧での状態確認

### 6.3 入力

- ローカル UI からのテキスト送信
- Discord からのテキスト送信
- ローカル UI からの画像送信
- Discord からの画像送信
- ローカル UI からの一般ファイル送信
- Discord からの一般ファイル送信
- ローカル UI の drag & drop / paste 添付

### 6.4 Codex 設定

- model 切り替え
- reasoning level 切り替え
- fast mode 切り替え
- 実行停止
- Codex `review` 実行機能は現時点では未提供

### 6.5 表示

- queued / running / waiting_codex / completed / stopped / error
- 途中 assistant メッセージ
- 実行コマンド表示
- キュー待ちターン数表示
- UI 側の経過表示
- Discord 側の進捗表示
- schedule 由来メッセージ表示
- 開発者コンソール表示

### 6.6 ファイル変更通知

有効化時は次ができます。

- 指定フォルダ監視
- create / modify / delete 検知
- Discord ログチャンネルへの通知
- create / modify 時のファイル添付

## 7. Discord 連携

現在の slash command は `/codex` 名前空間です。

対応サブコマンド:

- `help`
- `session`
- `new`
- `rename`
- `status`
- `model`
- `reasoning`
- `fast on`
- `fast off`
- `stop`

旧形式コマンド:

- `!status`
- `!new`
- `!bind <sessionId>`

## 8. 添付ファイルの扱い

### 8.1 画像

画像は Codex CLI の画像入力オプションで渡します。

### 8.2 画像以外

画像以外のファイルはローカルに保存し、その保存パスをプロンプトに追記して Codex に参照させます。

### 8.3 保存先

添付ファイルは主に次へ保存されます。

- `data/uploads/`

## 9. 永続化

### 9.1 データベース

SQLite の保存先:

- `data/bridge.sqlite`

### 9.2 保存内容

- セッション情報
- イベント履歴
- Discord 紐付け情報
- Codex 状態情報
- developer console 用ログ

## 10. 設定

設定元:

- `.env`

重要な変数:

- `PORT`
- `HOST`
- `CODEX_COMMAND`
- `CODEX_WORKDIR`
- `CODEX_ENABLE_SEARCH`
- `CODEX_APPROVAL_POLICY`
- `CODEX_SANDBOX_MODE`
- `CODEX_BYPASS_APPROVALS_AND_SANDBOX`
- `DISCORD_BOT_TOKEN`
- `DISCORD_ALLOWED_GUILD_IDS`
- `DISCORD_ALLOWED_CHANNEL_IDS`
- `DISCORD_STATUS_UPDATES`
- `FILE_WATCH_ENABLED`
- `FILE_WATCH_ROOT`
- `FILE_LOG_CHANNEL_ID`

現在のルール:

- `DISCORD_ALLOWED_GUILD_IDS` は 1 つだけ指定する

## 11. セキュリティに関係する挙動

このプロジェクトは設定次第で次を行います。

- 外部ネットワークアクセス付き Codex 実行
- 承認なし・sandbox 制限なし Codex 実行
- ファイル保存
- Discord への会話送信
- Discord へのファイル送信

そのため、現時点では「強力なローカル作業ツール」であり、「安全設計が完了した製品」ではありません。

## 12. Tauri 版の現在地

現時点の Tauri 版は、軽量ラッパーとして動作しますが、まだ次を前提にしています。

- ローカルに Node.js が入っている
- ローカルに Codex CLI が入っている

つまり、完全スタンドアロン配布物ではありません。close 時は確認ダイアログを表示し、起動前には残留 bridge process を掃除してから接続を試みます。

## 13. 現在の制約

- Windows 前提
- Discord サーバーは 1 つ前提
- ローカル利用前提
- 多人数向けではない
- 公開ネットワーク向けではない
