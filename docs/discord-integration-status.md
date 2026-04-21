# multiCLI-discord-base Discord 連携の現状

更新日: 2026-04-21

対象リポジトリ:

- `<repository-root>`

本書では `<repository-root>` を、このリポジトリを clone したフォルダとして表記する。

## 結論

multiCLI-discord-base の Discord 連携は、現時点では**実運用可能な状態**にある。  
特に重要な次の要件は、実コード・DB・live evidence・stress test のすべてで整合している。

- Discord と UI / Terminal が同じ persistent PTY を共有する
- 1 channel ↔ 1 workspace で binding する
- binding のない channel では plain message で auto-create しない
- plain routing と explicit agent routing の両方を扱う
- 添付ファイルを保存して prompt に反映する
- partial reply と working status を Discord に出す

## 現在の仕様

### 1. Discord command

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
- `checkpoints! create [label]`
- `rollback! preview <checkpointId>`
- `rollback! apply <checkpointId>`
- `skills! [agent]`
- `skills! apply [agent]`
- `new!`
- `workspace! <名前>`
- `agents!`
- `stop!`
- `agentName? <prompt>`
- plain `<prompt>`

slash command は廃止済みで、interaction には deprecated notice を返す。

### 2. binding

- 1 channel ↔ 1 workspace
- 1 workspace ↔ 1 channel
- rebinding 時は古い紐づけを解除して新しい channel を採用する
- unbound channel の plain message には guidance を返す

### 3. PTY routing

Discord prompt は `AgentBridge.runPrompt()` を通って `PtyService.sendPrompt()` に入る。  
したがって、Discord から送った prompt は **`${workspaceId}:${agentName}`** の shared PTY に流れる。

### 4. message sync

- assistant partial は safe boundary で Discord に段階送信する
- working status は定期更新する
- 完了時は `Completed` / `Stopped` / `Error` に更新する
- queue がある場合は queued notice を返す

### 5. attachment

- 画像添付と通常ファイル添付の両方を扱う
- plain routing と explicit agent routing の両方で prompt に反映する
- DB 上も `Images:` / `Files:` つきの user message として永続化される

## 実装上の主なファイル

- `server\src\discord-adapter.js`
- `server\src\agent-bridge.js`
- `server\src\pty-service.js`
- `server\src\http-server.js`
- `ui\multiCLI-discord-base.js`

## UI からの Discord 設定

UI は `/api/discord/channels` と `/api/workspaces/:id/discord-binding` を使って channel 一覧と binding 状態を扱う。  
以前あった response shape の不整合は解消済みで、現在の docs では**未解決バグ扱いにしない**。

## live / stress 検証の現在地

2026-04-21 時点:

- base regression suite: **73 通過 / 0 失敗**
- extended regression suite: **261 通過 / 0 失敗**
- `stress_tests`: **done 261 / pending 0**

代表的に確認済みのもの:

- bound channel の `help!`
- bound channel の `status!`
- unbound channel の guidance
- `workspace! <名前>` による create / bind
- plain prompt routing
- explicit agent routing
- attachment routing
- queue / reload / rebind / restart recovery
- bindings / resume / restart / checkpoint / rollback / skills command
- terminal observed / shared PTY continuity

## 現時点での注意

- Discord browser automation は tab 状態に影響されやすい
- 実ブラウザで再検証する場合は fresh tab のほうが安定
- `.env` の `DISCORD_ALLOWED_GUILD_IDS` は 1 guild 運用前提

## 運用判断

現時点では、Discord 連携を「未完成」と扱うより、**現仕様として稼働中**と扱うのが妥当。  
今後の主な作業は新機能追加よりも、UI 改善や運用ドキュメント整備になる。
