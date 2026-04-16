![multiCLI-discord-base header](header.jpg)

# multiCLI-discord-base

multiCLI-discord-base は、**persistent interactive PTY** を主経路にした Windows 向けのローカル AI ワークスペースです。  
Gemini CLI / Claude Code / GitHub Copilot CLI / Codex CLI を、**ローカル UI / Terminal / Discord / Schedule で同じ PTY を共有する**形で運用できます。

> **最初に読んでください**  
> multiCLI-discord-base はローカル PC 上で CLI を直接実行し、作業ディレクトリのファイルやプロンプトを扱います。公開サーバー用途ではありません。導入前に `SECURITY.md` を確認してください。

## この README の前提

- この README では `<repository-root>` を、このリポジトリを clone したフォルダとして表記します。
- **正式名称は multiCLI-discord-base** ですが、ローカルのフォルダ名は任意です。今のチェックアウト先が `...\multicodi` のままでも動作します。
- UI の正式ファイル名は `ui\multiCLI-discord-base.html` です。

## できること

- ワークスペースを作成し、親 agent を 1 つ選んで作業を始める
- 同じワークスペース内に子 agent を追加する
- main chat から bare prompt を親 agent に送る
- `agentName? prompt` で子 agent に送る
- **`${workspaceId}:${agentName}`** 単位の shared PTY を Chat / Terminal / Discord / Schedule で共有する
- Discord channel と workspace を 1:1 で紐づける
- Discord から plain prompt / explicit agent prompt / 添付ファイルを同じ PTY に流す
- 途中応答を UI / Discord に段階的に反映する
- scheduler から既存 workspace agent へ定期実行する
- custom agent を UI から追加・編集する

## 今の仕様で重要な前提

1. 主経路は **headless one-shot 実行ではなく persistent interactive PTY** です。
2. PTY key は **`${workspaceId}:${agentName}`** です。
3. Chat / Terminal / Discord / Schedule は、同じ workspace x agent の**同じ stdin/stdout**を共有します。
4. Discord は **1 channel ↔ 1 workspace** です。
5. binding のない channel では、plain message で勝手に workspace を作りません。
6. Discord slash command は廃止済みです。`!help`、`!status`、`!new`、`workspace?`、`agents?`、`stop?`、`agentName? prompt` を使います。

## 対応 CLI

- `gemini`
- `claude`
- `copilot`
- `codex`

agent 定義の初期例は `config\agents.example.json` にあります。

## 動作環境

- Windows
- Node.js 22 以上
- npm
- 利用したい CLI 本体のインストールとログイン
- Discord 連携を使う場合は Discord Bot

確認例:

```powershell
node -v
npm -v
gemini --help
claude --help
copilot --help
codex --help
```

## 非エンジニア向けのいちばん簡単な導入手順

### 1. フォルダを用意する

この README では、プロジェクトが次の場所にある前提で説明します。

`<repository-root>`

別の場所に置いた場合は、以降のコマンド中のパスを自分の環境に読み替えてください。

### 2. PowerShell を開く

`<repository-root>` をエクスプローラーで開き、アドレスバーに `powershell` と入力して Enter を押すのが簡単です。

### 3. 依存パッケージを入れる

```powershell
Set-Location "<repository-root>"
npm install
```

### 4. 設定ファイルをコピーする

```powershell
Copy-Item ".env.example" ".env"
Copy-Item ".\config\cli-settings.example.json" ".\config\cli-settings.json"
Copy-Item ".\config\agents.example.json" ".\config\agents.json"
Copy-Item ".\config\app-settings.example.json" ".\config\app-settings.json"
```

### 5. `.env` を埋める

`<repository-root>\.env` をメモ帳などで開きます。最小構成は次です。

```dotenv
PORT=3087
HOST=127.0.0.1
DATA_DIR=./data

DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_GUILD_IDS=
DISCORD_ALLOWED_CHANNEL_IDS=

FILE_WATCH_ENABLED=false
FILE_WATCH_ROOT=
FILE_LOG_CHANNEL_ID=
```

補足:

- `PORT=3087` が既定です。すでに別ポートを使っているなら変更して構いません。
- Discord を使わないなら `DISCORD_*` は空欄でも起動できます。
- `DISCORD_ALLOWED_GUILD_IDS` は、今の実装では **1 つの guild ID** を入れる運用を前提にしています。

### 6. CLI 設定を確認する

`config\cli-settings.json` で CLI コマンドや Codex の既定作業ディレクトリを確認します。

例:

```json
{
  "commands": {
    "claude": "claude",
    "gemini": "gemini",
    "copilot": "copilot",
    "codex": "codex"
  }
}
```

CLI のコマンド名が違う場合だけ修正してください。

### 7. agent 定義を確認する

`config\agents.json` で、最初に使いたい agent を決めます。1 agent だけにしておくと、workspace 作成時に親 agent が自動選択されやすくなります。

### 8. 起動する

もっとも簡単な起動方法:

```powershell
Set-Location "<repository-root>"
.\start-multiCLI-discord-base.bat
```

これで server を起動し、health check 成功後に UI を開きます。

### 9. 開く URL

既定値のままなら:

- `http://127.0.0.1:3087/multiCLI-discord-base.html`

`.env` の `PORT` や `HOST` を変えた場合は、その値に合わせて開いてください。

## AI に導入してもらうときのおすすめプロンプト

CoDiCoDi README の導線にならって、**「AI ができる作業は AI にやってもらい、人が必要な情報だけ答える」**形にすると進めやすいです。

### 汎用テンプレート

```text
<repository-root> にある multiCLI-discord-base をセットアップして。
まず README と SECURITY.md を読んで、PowerShell 前提で進めて。
できる作業は AI 側で進め、必要な情報だけ順番に質問して。
Discord Bot の作成や CLI ログインなど、人が手でやる必要がある部分は、非エンジニア向けに丁寧に案内して。
最後に <repository-root>\start-multiCLI-discord-base.bat で起動できる状態にして、必要ならデスクトップショートカットも作って。
```

### Discord も含めて任せるテンプレート

```text
<repository-root> の multiCLI-discord-base を導入して。
Gemini CLI / Claude Code / GitHub Copilot CLI / Codex CLI のうち、今このPCで使えるものを確認して、設定ファイルも整えて。
Discord 連携まで使いたいので、必要になったタイミングで
1. Discord Bot Token
2. 許可する Discord guild ID
3. 必要なら channel ID
だけを質問して。
そのほかはできるだけ自動で進めて、最後に動作確認の手順も書いて。
```

### うまく進めるコツ

- AI には**今の実フォルダ**を明示する
- **PowerShell 前提**と書く
- **できる作業は AI 側で進める**と明示する
- **手作業が必要な箇所は非エンジニア向けに説明して**と書く
- 最後に **`<repository-root>\start-multiCLI-discord-base.bat` で起動確認まで**依頼する

## Discord を使う場合の設定

### 1. Discord Bot を作る

1. Discord Developer Portal を開く
2. Application を新規作成する
3. `Bot` タブで Bot を作る
4. Token をコピーする
5. `Message Content Intent` を ON にする

### 2. Bot を guild に招待する

必要な権限の目安:

- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Attach Files

### 3. guild ID を控える

Developer Mode を ON にして、使う guild の ID をコピーします。

### 4. `.env` を更新する

```dotenv
DISCORD_BOT_TOKEN=ここにBotトークン
DISCORD_ALLOWED_GUILD_IDS=ここにguild ID
DISCORD_ALLOWED_CHANNEL_IDS=
```

## 使い方

### ローカル UI

1. workspace を作成する
2. 親 agent を 1 つ選ぶ
3. Chat で bare prompt を送ると親 agent に入る
4. `agentName? prompt` で子 agent に送る
5. agent カードを開くと、その agent の Terminal を見られる

### Discord

主なコマンド:

- `!help`
- `!status`
- `!new`
- `workspace? <名前>`
- `agents?`
- `stop?`
- `agentName? <prompt>`
- plain `<prompt>`（binding 済み channel の parent agent へ送信）

重要:

- binding のない channel では、plain message だけでは workspace を自動作成しません
- workspace を作るか紐づけるには `!new` または `workspace? <名前>` を使います
- slash command は廃止済みです

## 主要ファイル

### 起動・画面

- `start-multiCLI-discord-base.bat`
- `start-multiCLI-discord-base.ps1`
- `launch-browser.ps1`
- `ui\multiCLI-discord-base.html`
- `ui\multiCLI-discord-base.js`
- `ui\multiCLI-discord-base.css`

### サーバー

- `server\src\index.js`
- `server\src\http-server.js`
- `server\src\pty-service.js`
- `server\src\agent-bridge.js`
- `server\src\discord-adapter.js`

### 設定

- `.env`
- `config\cli-settings.json`
- `config\agents.json`
- `config\app-settings.json`

### ドキュメント

- `docs\MULTI_CLI_SPEC.md`
- `docs\discord-integration-status.md`
- `docs\discord-multiCLI-discord-base-test-plan.md`
- `SECURITY.md`

## 現在の制約

- Windows 前提です
- agent rename は未対応です
- 既存の agent type は作成後固定です
- Discord は 1 channel ↔ 1 workspace です
- ブラウザ自動操作で Discord を触るときは、fresh tab のほうが安定します

## 現在の検証状態

- repo 回帰 suite: `scripts\test-multiCLI-discord-base-extended.mjs`
- 最新結果: **171 通過 / 0 失敗**
- stress test 台帳: **done 261 / pending 0**

## ライセンス

MIT License. 詳細は `LICENSE` を確認してください。
