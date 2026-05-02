# multiCLI-discord-base Agent Orchestrator 調査と実装ロードマップ

更新日: 2026-04-27

対象リポジトリ:

- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base`
- 調査元: `https://github.com/andyrewlee/awesome-agent-orchestrators`

本書は、`awesome-agent-orchestrators` 掲載ツールの調査結果を multiCLI-discord-base 向けに再整理し、今後の機能追加・改修を**優先度順**に並べた実装計画としてまとめたものである。

---

## 1. 結論

multiCLI-discord-base の現在の方向性である

- workspace-first
- persistent PTY-first
- browser UI + terminal/chat sync
- Discord bridge
- multi-agent routing

は、調査対象の中でも**十分に有望で、むしろ主流設計の一つ**だった。

特に多くの成熟プロジェクトで共通していた中核は次の 4 点である。

1. **agent ごとの isolation**  
   git worktree / sandbox / container / VM
2. **persistent terminal runtime**  
   tmux / PTY / embedded terminal
3. **control plane**  
   scheduler / mailbox / claim / daemon / dashboard
4. **safety loop**  
   verifier / janitor / retry / revert / audit

したがって、multiCLI-discord-base は大きく方向転換する必要はない。  
むしろ **「shared PTY を軸にした control plane と safety layer を足す」** のが最も筋が良い。

---

## 2. 調査対象の見方

`awesome-agent-orchestrators` 掲載の 97 ツールを次の観点で見た。

- UX surface: CLI / TUI / web / desktop / messaging
- orchestration model: parallel runner / worktree / kanban / swarm / loop
- multiCLI-discord-base との近さ
- 部分的に借りられる機能
- 成熟度と継続性

詳細なカテゴリ別ノートは次のファイルに保存済みである。

- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-parallel-1.txt`
- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-parallel-2.txt`
- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-parallel-3.txt`
- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-assistants-1.txt`
- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-assistants-2.txt`
- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-swarms.txt`
- `C:\Users\sgmxk\.copilot\session-state\97b27d35-9664-4809-b083-af16c9b54c0b\files\agent-orchestrators-loops.txt`

---

## 3. multiCLI-discord-base に近かった本命ツール

### 3.1 方向性が非常に近い

| ツール | 近い点 | 特に参考になる点 |
|---|---|---|
| `andyrewlee/amux` | workspace-first / PTY / worktree | PTY tracing、metadata、instrumentation |
| `njbrake/agent-of-empires` | terminal + browser dashboard | remote/mobile access、status detection |
| `rustykuntz/clideck` | browser UI + terminal + routing | autopilot handoff、mobile remote |
| `superset-sh/superset` | worktree + GUI + diff/review | diff viewer、workspace preset、editor handoff |
| `sahithvibudhi/vibe-tree` | persistent terminals + web/desktop | cross-platform remote view、per-worktree session |
| `oxgeneral/ORCH` | daemon + adapters + TUI | headless mode、template team、structured logs |
| `spencermarx/orc` | worktree-per-agent lifecycle | bead lifecycle、review pipeline |
| `aannoo/hcom` | terminal-first agent comms | mailbox、subscriptions、relay |
| `banteg/takopi` | messaging bridge + worktree | resume line、progress streaming |
| `openclaw/openclaw` | gateway + session routing | channel routing、onboarding、control plane |

### 3.2 部分的にかなり参考になる

| ツール | 参考ポイント |
|---|---|
| `chernistry/bernstein` | deterministic orchestration、janitor verification、artifact sink |
| `JesseRWeigel/toryo` | quality ratchet、commit/revert/retry、trust-based delegation |
| `sortie-ai/sortie` | scheduler、SQLite durable state、ticket-to-workspace orchestration |
| `amaar-mc/wit` | symbol-level semantic lock、contract enforcement |
| `phuryn/swarm-protocol` | intent / claim / signal / context primitives |
| `farol-team/gnap` | git-backed protocol、auditability、offline friendliness |
| `saltbo/agent-kanban` | leader-worker + board-driven orchestration |
| `Charlie85270/Dorothy` | super-agent、Kanban、remote control |
| `nearai/ironclaw` | sandbox、credential injection、security boundary |
| `moshthepitt/lionclaw` | trusted control plane、runtime confinement、audit trail |

---

## 4. 調査から見えた主要パターン

### 4.1 ほぼ共通だったもの

- worktree isolation
- persistent terminal session
- scheduler / daemon / control plane
- audit / review / verify / retry
- browser or desktop dashboard
- messaging bridge

### 4.2 mature なプロジェクトほど持っていたもの

- provider abstraction
- run state persistence
- agent role / mode / policy
- remote monitoring
- structured logs / evidence
- policy / sandbox / credentials boundary

### 4.3 multiCLI-discord-base が今後伸ばすべき強み

multiCLI-discord-base 固有の強みは、**Chat / Terminal / Discord が同じ shared PTY に揃うこと**である。  
この強みは他プロダクトにも完全一致ではあまり見られず、次の形で伸ばすのが良い。

1. shared PTY を維持したまま control plane を強くする
2. Discord を notifer ではなく first-class channel として洗練する
3. autonomous 化しても terminal visibility を失わないようにする

---

## 5. 今後の設計方針

### 5.1 維持すべき中核

- 主経路は persistent interactive PTY
- workspace-first を維持する
- `\${workspaceId}:\${agentName}` shared PTY key を維持する
- Chat / Discord / Terminal は同じ PTY stdin/stdout に揃える

### 5.2 強化すべき層

- **coordination layer**
- **safety layer**
- **remote operation layer**
- **workflow / review layer**

---

## 6. 優先度付きロードマップ

以下では、機能追加・改修を **P0 → P3** の順に並べる。  
各項目は **[目的] → [実装] → [検証]** の形式で記載する。

---

## 7. P0: 最優先で入れるべき基盤

P0 は「multi-agent 化を進めても破綻しにくくする」ための層である。  
ここを先に固めないと、その上の Kanban / automation / remote UI が不安定になりやすい。

### P0-1. intent / claim / handoff control plane

**参考元**

- `phuryn/swarm-protocol`
- `aannoo/hcom`
- `rustykuntz/clideck`
- `bfly123/claude_code_bridge`

**目的**

- agent 間 handoff を明文化する
- 「いま誰が何を担当しているか」を UI / Discord / backend で共通化する
- prompt routing だけでなく task routing を扱えるようにする

**実装**

- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\agent-bridge.js`
  - `handoffTask()`
  - `claimTask()`
  - `releaseTask()`
  - `getTaskContext()`
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\http-server.js`
  - `/api/workspaces/:id/tasks`
  - `/api/workspaces/:id/handoffs`
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\ui\multiCLI-discord-base.js`
  - current claim / assigned task / handoff queue 表示
- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\server\src\discord-adapter.js`
  - `assign!`
  - `handoff!`
  - `claims!`

**検証**

- 1 workspace 内で 2 agent が task claim / release できる
- Discord / UI / Terminal のどこからでも claim 状態が見える
- stale claim が timeout / kill / reset 後に残らない

### P0-2. symbol-level conflict warning / semantic lock

**参考元**

- `amaar-mc/wit`
- `phuryn/swarm-protocol`

**目的**

- multi-agent 同時編集時の衝突を、ファイル単位ではなく symbol 単位で早めに警告する
- 「保存してから壊れる」ではなく「着手前に危険が見える」状態にする

**実装**

- lightweight daemon または backend module で lock registry を保持
- Tree-sitter か簡易 AST ベースで symbol key を作る
- 編集前 / task claim 時に warning を返す
- UI 上で `warning / locked / contested` を出す

**検証**

- 同じ function / class を 2 agent が claim すると warning が出る
- 異なる symbol 編集では warning が出ない
- claim release 後に lock が自動解除される

### P0-3. durable run state + resumable evidence

**参考元**

- `farol-team/gnap`
- `wreckit`
- `ralph-claude-code`
- `sortie`

**目的**

- DB だけでなく inspectable な run state を残す
- 再開・監査・復旧をやりやすくする

**実装**

- `data` 配下または workspace ごとに run summary / claim / handoff / verifier result を JSON / Markdown で保存
- PTY transcript summary と latest task state を切り出して保存
- `resume` / `status` / `audits` から参照できるようにする

**検証**

- server restart 後も run state を復元できる
- claim / handoff / verifier 状態がファイルから追える
- broken session の手動復旧に必要な情報が残る

### P0-4. verifier / janitor / retry gate

**参考元**

- `chernistry/bernstein`
- `JesseRWeigel/toryo`
- `ikamensh/kodo`
- `wreckit`

**目的**

- 自律化しても「壊れた差分がそのまま前に進む」状態を減らす
- 実装 agent と検証 agent を分離する

**実装**

- run complete 後に optional verifier run を追加
- verifier は
  - tests
  - lint
  - type-check
  - custom command
  の preset を持つ
- fail 時は
  - retry
  - revert
  - human review required
  を選べるようにする

**検証**

- verifier pass で run が `verified`
- verifier fail で retry / blocked へ遷移
- evidence が UI / Discord に出る

---

## 8. P1: 運用性を大きく上げる改修

### P1-1. headless daemon + remote dashboard

**参考元**

- `coollabsio/jean`
- `Dimillian/CodexMonitor`
- `njbrake/agent-of-empires`
- `rustykuntz/clideck`

**目的**

- 常駐 server を first-class に扱う
- remote / mobile / browser から監視しやすくする

**実装**

- daemon mode の起動状態を明示
- remote token / WebSocket control / read-only viewer を整備
- terminal mirror と workspace health を軽量表示

**検証**

- local UI を閉じても daemon が継続
- remote viewer で active workspace / PTY 状態 / queue が見える
- token 無しでは control 系 API に触れない

### P1-2. Discord bridge の operation layer 強化

**参考元**

- `banteg/takopi`
- `openclaw/openclaw`
- `letta-ai/lettabot`
- `Michaelliv/mercury`

**目的**

- Discord を単なる message relay ではなく運用面の主チャネルに近づける

**実装**

- resume line
- progress streaming 改善
- silent working mode
- pairing / operator permission
- claim / verifier / handoff 通知

**検証**

- queue / handoff / verifier 状態が Discord で追える
- noisy すぎず silent mode でも必要情報が残る
- operator 権限のない user は危険 command を打てない

### P1-3. runtime boundary / sandbox / audit

**参考元**

- `nearai/ironclaw`
- `moshthepitt/lionclaw`
- `gavrielc/nanoclaw`
- `NVIDIA/NemoClaw`

**目的**

- 長期的な安全性と credential 管理を強化する

**実装**

- agent type ごとの execution policy
- allowlist / denylist
- credential injection policy
- command audit receipt
- 将来的な container / VM mode に備えた abstraction

**検証**

- 禁止 command が policy で止まる
- credential を prompt に漏らさず注入できる
- 実行ログと decision reason が残る

---

## 9. P2: UX と workflow を一段引き上げる機能

### P2-1. task board / Kanban integration

**参考元**

- `saltbo/agent-kanban`
- `techdufus/openkanban`
- `Charlie85270/Dorothy`
- `BloopAI/vibe-kanban`

**目的**

- workspace 単位の運用から、task 単位の可視化へ進める

**実装**

- minimal board
  - backlog
  - ready
  - running
  - blocked
  - review
  - done
- card ↔ workspace / claim / verifier を結びつける
- optional auto-create / auto-assign を追加

**検証**

- board card から workspace を開ける
- claim / verifier / review 状態が board と同期する
- DnD で task state が破綻しない

### P2-2. review / diff / preview flow

**参考元**

- `superset-sh/superset`
- `johannesjo/parallel-code`
- `21st-dev/1code`
- `BloopAI/vibe-kanban`

**目的**

- 実装後の「見る / 比べる / approve する」を UI 内で完結させる

**実装**

- built-in diff summary
- changed files preview
- review status
- one-click open / approve / request retry

**検証**

- run 完了後に diff が即見える
- verifier 結果と diff を同画面で追える
- Discord から review deep-link を開ける

### P2-3. workspace mode / persona / autonomy level

**参考元**

- `coollabsio/jean`
- `mikeyobrien/ralph-orchestrator`
- `JesseRWeigel/toryo`

**目的**

- 実行ポリシーを明示して、autonomy を扱いやすくする

**実装**

- workspace or run mode:
  - Plan
  - Build
  - Review
  - Yolo
- agent role:
  - planner
  - implementer
  - verifier
  - reviewer

**検証**

- mode ごとに許可 action と verifier policy が変わる
- role ごとに prompt / routing / tool policy が変わる

---

## 10. P3: 長期で効く拡張

### P3-1. multi-machine / remote worker

**参考元**

- `23blocks-OS/ai-maestro`
- `21st-dev/1code`
- `generalaction/emdash`

**目的**

- 単一 PC を超えて agent 実行先を広げる

**実装**

- remote runner abstraction
- local / SSH / container / cloud runner interface
- workspace placement policy

**検証**

- remote worker でも shared state と evidence が崩れない

### P3-2. visual canvas / situational awareness

**参考元**

- `collaborator-ai/collab-public`
- `rayzhudev/vibecraft`

**目的**

- 多数 agent の状況把握をしやすくする

**実装**

- optional canvas view
- agent / workspace / task / status node
- handoff line / blocked state / warning color

**検証**

- 5 以上の workspace でも current state を一覧把握できる

### P3-3. compile-time workflow validation

**参考元**

- `byronxlg/skillfold`

**目的**

- workflow / automation の設定破綻を実行前に減らす

**実装**

- YAML or JSON workflow schema
- route / state / verifier の整合チェック

**検証**

- invalid workflow を保存前に弾ける

---

## 11. 実装順の提案

最も妥当な順序は次のとおり。

1. **P0-1 intent / claim / handoff**
2. **P0-2 semantic lock**
3. **P0-3 durable run state**
4. **P0-4 verifier / retry gate**
5. **P1-1 headless daemon + remote dashboard**
6. **P1-2 Discord operation layer**
7. **P1-3 sandbox / audit**
8. **P2-1 task board**
9. **P2-2 diff / review / preview**
10. **P2-3 mode / persona**
11. **P3-1 remote worker**
12. **P3-2 canvas**
13. **P3-3 workflow validation**

この順で進める理由は次の通り。

- task board や remote worker より先に **coordination と safety** を固めるべき
- Discord を強化する前に **claim / verifier / audit のイベント源** が必要
- advanced UX の前に **run state と policy** を固めたほうが実運用しやすい

---

## 12. 最初のスプリント案

まず 1 スプリント分としては次が良い。

### Sprint A

1. claim / handoff API
2. UI の current task / owner 表示
3. Discord `claims!` / `handoff!`
4. durable run summary 保存

### Sprint B

1. semantic lock warning
2. verifier preset
3. verifier status UI / Discord 通知

### Sprint C

1. daemon visibility
2. remote read-only dashboard
3. operator permission / pairing

---

## 13. この調査からの最重要判断

multiCLI-discord-base は、

- 既存の PTY-first 方針を維持し
- worktree / claim / verifier / audit を強化し
- Discord と browser を control plane の front-end として育てる

のが最善である。

特に次の一文が本計画の要点である。

> **shared PTY を中心に据えたまま、agent orchestration の control plane と safety plane を追加する。**

この方針なら、現在の強みを捨てずに成熟プロジェクト群の良い部分を取り込める。
