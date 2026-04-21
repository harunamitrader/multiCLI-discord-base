# multiCLI-discord-base 現行仕様書

更新日: 2026-04-16

対象リポジトリ:

- `<repository-root>`

本書では `<repository-root>` を、このリポジトリを clone したフォルダとして表記する。

## 1. 目的

multiCLI-discord-base は、複数の CLI 型 AI を **workspace / agent / persistent PTY** で統一管理し、同じ実行セッションを以下の複数 surface から共有するためのローカルアプリケーションである。

- ローカル UI main chat
- ローカル UI terminal
- Discord
- schedule

主目的は、**同じ workspace の同じ agent に対して、surface が変わっても同じ CLI プロセスと会話を継続できること**である。

## 2. 固定前提

1. 主経路は **persistent interactive PTY**。
2. headless one-shot 実行は主経路にしない。
3. canonical PTY key は **`${workspaceId}:${agentName}`**。
4. Chat / Terminal / Discord / Schedule は、同じ PTY stdin/stdout を共有する。
5. Discord は **1 channel ↔ 1 workspace**。
6. binding のない channel では plain message から自動 workspace 作成をしない。
7. Discord slash command は廃止し、`!` / `?` command を使う。

## 3. 用語

### 3.1 workspace

- backend の作業単位
- UI 上では session 相当の概念として見せる
- 名前、workdir、親 agent、子 agent 群、message timeline、Discord binding を持つ

### 3.2 parent agent

- workspace の既定 agent
- bare prompt の送信先
- Discord の plain message の送信先

### 3.3 child agent

- 同じ workspace に追加される補助 agent
- `agentName? prompt` で明示的に呼び出す

### 3.4 PTY

- 実 CLI プロセスに接続された永続 pseudo terminal
- 1 workspace x 1 agent ごとに 1 つ持つ
- raw stdin/stdout を shared transport として扱う

## 4. 対応 CLI

- Gemini CLI
- Claude Code
- GitHub Copilot CLI
- Codex CLI

agent 定義は次で管理する。

- `config\agents.json`

CLI コマンド override と Codex の既定値は次で管理する。

- `config\cli-settings.json`

## 5. アーキテクチャ

### 5.1 server

主要ファイル:

- `server\src\index.js`
- `server\src\http-server.js`
- `server\src\pty-service.js`
- `server\src\agent-bridge.js`
- `server\src\discord-adapter.js`
- `server\src\scheduler.js`

責務:

- workspace / agent / PTY lifecycle 管理
- SQLite 永続化
- SSE 配信
- HTTP API 提供
- Discord integration
- schedule 実行
- attachment 保存

### 5.2 UI

主要ファイル:

- `ui\multiCLI-discord-base.html`
- `ui\multiCLI-discord-base.js`
- `ui\multiCLI-discord-base.css`

責務:

- workspace 一覧表示
- main chat 表示
- agent 一覧 / agent 設定 / workspace 設定
- terminal 表示
- streaming delta と working indicator 表示

### 5.3 data

既定の保存先:

- `data`

主要 DB:

- `data\bridge.sqlite`

## 6. UI 仕様

### 6.1 主要画面

UI の入口:

- `http://127.0.0.1:3087/multiCLI-discord-base.html`

`.env` の `HOST` / `PORT` を変えた場合はその値を使う。

### 6.2 タブ

上部タブは次の 3 つ。

- Chat
- Settings
- Agents

terminal は上部タブの常設ボタンではなく、選択中 agent に応じて表示を切り替える。

### 6.3 main chat

- workspace timeline を表示する
- bare prompt は parent agent に送る
- `agentName? prompt` は対象 agent に送る
- assistant partial は safe boundary 単位で段階的に表示する
- working indicator は秒表示から始まり、一定時間以降も更新し続ける

### 6.4 terminal

- authoritative な CLI 表示面
- 同じ workspace x agent の shared PTY を表示する
- reconnect / kill を提供する
- Chat / Discord / Schedule と同じ stdin/stdout を共有することを明示表示する
- approval pending / quota wait / recovery warning を banner / status に出す

### 6.5 settings

- global default workdir
- workspace 名 / workdir / parent agent / Discord channel binding
- agent model / workdir / mode / instruction
- global / workspace / agent ごとの markdown memory を編集できる

### 6.6 agents

- 登録済み agent の一覧
- custom agent の新規作成
- 既存 agent の編集 / 削除

## 7. PTY 仕様

### 7.1 基本

- PTY は workspaceId + agentName ごとに 1 つ
- 再送信時は同じ PTY を使う
- process が未起動なら初回送信時に spawn する
- runtime snapshot は `data\state.json` に保存し、restart 後は safe-side で `idle + runtime_recovered warning` に戻す

### 7.2 共有面

次の入力は同じ PTY に入る。

- UI main chat
- UI terminal input
- Discord prompt
- scheduler prompt

次の出力は同じ PTY から組み立てる。

- terminal raw output
- UI main chat assistant text
- Discord assistant text
- DB 永続化メッセージ

### 7.3 出力整形

- raw PTY transcript を取り込む
- Gemini / Claude など CLI ごとの transcript sanitize を行う
- safe boundary で partial flush する
- 最終的な assistant text を DB に保存する

## 8. Discord 仕様

### 8.1 有効化条件

`.env` の次を使う。

- `DISCORD_BOT_TOKEN`
- `DISCORD_ALLOWED_GUILD_IDS`
- `DISCORD_ALLOWED_CHANNEL_IDS`

現在の運用前提:

- `DISCORD_ALLOWED_GUILD_IDS` は 1 guild

### 8.2 channel binding

- 1 channel ↔ 1 workspace
- 1 workspace ↔ 1 channel
- rebinding 時は古い binding を解除し、新しい channel を登録する

### 8.3 command

有効コマンド:

- `help!`
- `status! [agent]`
- `output! [agent]`
- `enter! [agent]`
- `approve! [agent]`
- `deny! [agent]`
- `bindings!`
- `resume! [agent]`
- `restart! [agent]`
- `checkpoints!`
- `rollback!`
- `skills! [agent]`
- `new!`
- `workspace! <名前>`
- `agents!`
- `stop!`
- `agentName? <prompt>`
- plain `<prompt>`

挙動:

- binding 済み channel の plain prompt は parent agent に送信
- unbound channel の plain prompt は guidance を返す
- `status!` は workspace / default agent / 各 agent の PTY 状態を返し、agent 指定で絞り込み可能
- `status!` には approval pending / quota wait / recovery warning / drift warning を含める
- `output!` は shared PTY の最新 scrollback tail を返す
- `enter!` は既存 shared PTY に Enter だけを送る。PTY 未起動時は自動 spawn しない
- `approve!` / `deny!` は shared PTY 上の承認待ちへ `y` / `n` を返す
- `bindings!` / `resume!` / `restart!` / `checkpoints!` / `rollback!` / `skills!` は workspace runtime の運用操作を Discord から行う
- `new!` は channel 名ベースで workspace を作る
- `workspace! <名前>` は既存 workspace に bind、なければ作成
- `command!` 系は、**メッセージ冒頭から最初の `!` まで** が既知コマンド名と完全一致した時だけ command として扱う

### 8.4 slash command

- 廃止済み
- interaction には deprecated notice を返す

### 8.5 添付ファイル

- 画像 / ファイル添付を保存して prompt に反映する
- plain routing と explicit agent routing の両方で扱う

### 8.6 進捗表示

- partial assistant text を分割投稿する
- `Working...` を一定間隔で更新する
- 完了時に `Completed` / `Stopped` / `Error` へ更新する
- queue がある場合は `Queued as next turn.` 等を返す

## 9. Schedule 仕様

主要 API:

- `GET /api/schedules`
- `POST /api/schedules`
- `PATCH /api/schedules/:name`
- `DELETE /api/schedules/:name`
- `GET /api/schedule-defaults`
- `POST /api/schedule-defaults`
- `POST /api/schedule-defaults/workdir/browse`
- `POST /api/cron/describe`

動作:

- scheduler は既存 workspace agent を target にできる
- 実行経路は `AgentBridge.runScheduledJob()` を通り shared PTY に入る
- workdir 既定値を保存できる

## 10. 主要 API

workspace / agent:

- `GET /api/workspaces`
- `POST /api/workspaces`
- `PATCH /api/workspaces/:id`
- `DELETE /api/workspaces/:id`
- `GET /api/workspaces/:id/messages`
- `GET /api/workspaces/:id/agents`
- `POST /api/workspaces/:id/agents`
- `DELETE /api/workspaces/:id/agents/:agentName`
- `GET /api/workspaces/:id/discord-binding`
- `PUT /api/workspaces/:id/discord-binding`

agent:

- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:name`
- `DELETE /api/agents/:name`
- `POST /api/agents/:name/run`
- `GET /api/agents/:name/messages`
- `GET /api/agents/:name/runs`
- `GET /api/agents/:name/terminal-state`

runtime:

- `GET /api/health`
- `GET /api/runtime`
- `GET /api/app-settings`
- `PATCH /api/app-settings`
- `POST /api/server/restart`
- `GET /api/stream`

discord / uploads:

- `GET /api/discord/channels`
- `GET /uploads/...`

## 11. 設定ファイル

### 11.1 `.env`

場所:

- `<repository-root>\.env`

主に環境依存値を持つ。

- `PORT`
- `HOST`
- `DATA_DIR`
- `DISCORD_BOT_TOKEN`
- `DISCORD_ALLOWED_GUILD_IDS`
- `DISCORD_ALLOWED_CHANNEL_IDS`
- `FILE_WATCH_ENABLED`
- `FILE_WATCH_ROOT`
- `FILE_LOG_CHANNEL_ID`

### 11.2 `config\cli-settings.json`

- CLI コマンド override
- Codex defaults
- Codex workdir / search / approval / sandbox

### 11.3 `config\agents.json`

- agent 名
- agent 種別
- model
- settings

### 11.4 `config\app-settings.json`

- Discord status update 設定
- attachment 制限
- file watch debounce / ignore

## 12. 既知の制約

- Windows 前提
- agent rename は未対応
- CLI 種別は agent 作成後固定
- Discord の plain unbound auto-create は禁止
- browser automation で Discord を検証する場合、fresh tab のほうが安定

## 13. 現在の検証状態

2026-04-16 時点:

- repo regression suite: **171 通過 / 0 失敗**
- `stress_tests`: **done 261 / pending 0**

これにより、少なくとも次が live / regression ベースで確認済み。

- workspace 作成
- parent agent 自動選択
- terminal に実 CLI が表示されること
- same PTY 経由の Chat / Discord / Terminal 同期
- Discord plain routing
- Discord explicit agent routing
- Discord attachment routing
- queue / reload / rebind / restart recovery

## 14. 関連ドキュメント

- `<repository-root>\README.md`
- `<repository-root>\docs\discord-integration-status.md`
- `<repository-root>\docs\discord-multiCLI-discord-base-test-plan.md`
