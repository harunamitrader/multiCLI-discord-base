# Discord x multiCLI-discord-base 連携テスト計画

## 対象と制約

- 作業対象: `<repository-root>`
- Discord 実地テスト対象 guild は非公開の検証用サーバー 1 つに固定する
- **検証対象として許可した guild 以外は触らない**
- multiCLI-discord-base の主経路は persistent interactive PTY
- Chat / Discord / Schedule は Terminal タブと同じ PTY stdin/stdout を使う前提で確認する
- PTY key は `${workspaceId}:${agentName}`

本書では `<repository-root>` を、このリポジトリを clone したフォルダとして表記する。

## 目的

1. Discord からの入力が、正しい workspace / agent / PTY に流れることを確認する
2. 勝手な workspace / session 自動生成が起きないことを確認する
3. 明示コマンドでの workspace 作成・紐づけ・再紐づけが安全に動くことを確認する
4. 同一 workspace で Terminal / UI main chat / Discord の本文が相互に矛盾しないことを確認する
5. 途中メッセージが文の切れ目で逐次同期され、working 表示が継続更新されることを確認する
6. 負荷時・再起動時・複合操作時にも破綻しないことを確認する

## 使用手段

- live UI 操作: MCP browser / Chrome DevTools MCP
- backend 確認: multiCLI-discord-base HTTP API, SQL, PowerShell
- 回帰確認: `scripts\test-multiCLI-discord-base-extended.mjs`
- 証跡: スクリーンショット、`ui_test_runs`、`stress_tests`

## テストマトリクス

合計 **210 パターン** を `stress_tests` に登録済み。

| category | 件数 | 重点確認 |
| --- | ---: | --- |
| workspace-create | 15 | Discord 起点の workspace 作成、初回紐づけ |
| workspace-binding | 15 | 既存 workspace への紐づけ |
| workspace-rebinding | 15 | 1対1 制約での再紐づけ |
| plain-routing | 15 | plain message の parent agent ルーティング |
| agent-routing | 15 | `agentName? prompt` の対象 agent ルーティング |
| command-migration | 15 | slash 廃止後の `command!` / `agentName?` command 動作 |
| legacy-commands | 15 | `new!` など現行 command 形式の互換確認 |
| attachment-flow | 15 | 画像・ファイル添付の保存とプロンプト組み立て |
| terminal-sync | 15 | Discord 入出力が Terminal / PTY と整合するか |
| chat-persistence | 15 | UI / DB / history への保存 |
| workspace-settings | 15 | Discord channel 設定と live 挙動の同期 |
| restart-recovery | 15 | リロード / 再起動後の binding / resume |
| stress-load | 15 | 連投、キュー、負荷、複合操作 |
| error-guidance | 15 | 未紐づけ、削除済み binding、blocked 状況の案内 |

## 各カテゴリの代表ケース

### 1. workspace-create

- unbound channel で `new!`
- unbound channel で `workspace! <名前>`
- 既存 channel 名と同名 workspace がある場合の挙動
- 複数 agent 構成時の parent agent 決定

### 2. workspace-binding / workspace-rebinding

- 既存 workspace への binding
- 同じ workspace を別 channel に再紐づけ
- 再紐づけ後に旧 channel が unbound 案内へ戻るか
- defaultAgent の更新反映

### 3. plain-routing / agent-routing

- bound channel の bare prompt
- `agentName? prompt`
- 日本語、絵文字、コードブロック、長文、複数行
- 連投時の queue / completion 順

### 4. command-migration / legacy-commands

- `help!`
- `status!`
- `new!`
- `workspace! <名前>`
- plain message と command を交互に送る複合系

### 5. attachment-flow

- 画像 + テキスト
- text file + テキスト
- ファイルのみ
- 添付複数枚

### 6. terminal-sync / chat-persistence

- Discord prompt が同一 workspace の chat に保存されるか
- assistant reply が DB に保存されるか
- 同じ run が Discord と UI で矛盾しないか
- Terminal 面に同じ PTY セッション由来の出力が見えるか
- Terminal のシステム行 / 実行コマンドは UI / Discord に混ざらないか
- assistant 本文だけが文の切れ目で partial sync されるか
- UI が `working... (20s)` のように秒数表示を更新し続けるか
- Discord が 15 秒刻み、1 分以降は 1 分刻みで `working... (15s)` / `working... (3m)` を最下段更新するか

### 7. restart-recovery

- multiCLI-discord-base 再起動後の binding 維持
- Discord タブ reload 後の継続
- stale process 混在時の挙動
- 再起動直後の `new!` / plain prompt

### 8. stress-load

- 短時間の連投
- thinking 中の追加入力
- binding 切替直後の送信
- command → plain prompt → attachment → plain prompt の複合操作

### 9. error-guidance

- unbound channel の plain prompt
- 削除済み workspace binding
- defaultAgent 不整合
- 作成不能時のメッセージ品質

## 実行ルール

1. Discord は許可した検証用 guild のみ操作する
2. 各ケースは Discord / UI main chat / Terminal / DB の 4 面を突き合わせる
3. 問題を見つけたら即修正ではなく、まず `ui_test_runs` に再現を残す
4. 修正後は同一ケースを再試行して pass/fail を更新する
5. スクリーンショットは pass/fail 代表ケースごとに残す

## 現在の進捗

### live 実行サマリ

- `passed`: 4
- `failed`: 1
- `blocked`: 1

### live 実行済みケース

| id | status | 内容 |
| --- | --- | --- |
| discord-live-001 | passed | bound channel `workspace001` で plain prompt → `OK-001` |
| discord-live-002 | passed | unbound channel `メモ` で plain prompt → 自動作成されず案内表示 |
| discord-live-003 | failed | 初回 `new!` が複数 agent 構成で parentAgent 決定できず失敗 |
| discord-live-003-retest | passed | 修正後 `new!` で `メモ` workspace 作成成功 |
| discord-live-004 | passed | `new!` 後の `メモ` channel で plain prompt → `OK-004` |
| discord-live-login-blocked | blocked | 初回は Discord ログイン待ちで停止 |

## 今回の live で見つかった不具合と対応

### 不具合

- `new!` が unbound channel で「明示作成コマンド」のはずなのに、複数 agent 構成だと parentAgent を自動決定できず失敗した

### 対応

- `server\src\discord-adapter.js`
  - `new!` / `/codex new` の parent agent 解決を改善
  - 優先順: 単一 agent → active workspace の parent agent → 既存 workspace 群で一意な parent agent

### 回帰

- `scripts\test-multiCLI-discord-base-extended.mjs`
  - `Discord new! without binding → creates workspace`
  - `Discord new! without binding → reuses active workspace parent agent`
  - `Discord new! without binding → binds new workspace to channel`

## 証跡ファイル

- 証跡画像や live 実行ログは公開リポジトリ外の作業用保管先に保存する
- 公開版ドキュメントには、ローカルの session-state やスクリーンショット保存先を直接書かない

## 次のバッチ

1. `workspace-binding` / `workspace-rebinding` を live で消化
2. `help!` / `status!` / `workspace! <名前>` の live 実行
3. 添付ファイル系と stress-load 系の live 実行
4. Terminal 本文 / UI partial / Discord partial / working timer の 3 面同期を詰める
