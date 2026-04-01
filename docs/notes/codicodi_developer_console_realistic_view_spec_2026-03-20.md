# CoDiCoDi Developer Console 改善仕様書

作成日: 2026-03-20

## 1. 目的

`Open Developer Console` で開く PowerShell を、現在の単純な `raw log tail` から、`codex CLI を PowerShell で直接見ている感覚に近い表示` へ改善する。

ただし、内部構成は維持する。

- Codex CLI の起動主体は引き続き CoDiCoDi
- CoDiCoDi は Codex CLI の JSON 出力を内部で解析し続ける
- Developer Console は `人間向けの閲覧用コンソール` として強化する

## 2. 背景

現状の Developer Console は、`codex-live.log` を PowerShell で `Get-Content -Wait` しているだけであり、以下の問題がある。

- JSON 行がそのまま見えて読みづらい
- run の開始と終了が分かりにくい
- assistant の返答と command 実行が埋もれる
- `本物の codex CLI コンソール` らしさが薄い

そのため、`本物の codex CLI そのもの` にはしないまま、`本物っぽく見える専用デバッグコンソール` を設計する。

## 3. 非目的

今回の対象外は以下とする。

- 既存の外部 PowerShell で実行中の codex CLI への後付けアタッチ
- Developer Console からの対話入力
- CoDiCoDi と人間が同じ stdin/stdout を同時共有する実装
- Discord 側挙動の変更
- CoDiCoDi の queue / status / event 管理方式の全面変更

## 4. ゴール像

Developer Console を開いたとき、ユーザーは少なくとも次を直感的に把握できること。

- いま新しい run が始まったか
- どの model / reasoning / fast mode で動いているか
- どの user 入力が処理対象になったか
- assistant が考え始めたか
- command 実行が発生したか
- turn が成功・停止・失敗のどれで終わったか
- エラー原因が何か

## 5. UX 方針

- Developer Console は引き続き `読み取り専用` とする
- UI 上の入口は既存の `Open Developer Console` ボタンを継続使用する
- 既存の `codex-live.log` は raw 診断ログとして残す
- 新たに `人間向け整形ログ` を追加し、PowerShell はそちらを表示する
- 表示は `JSON の垂れ流し` ではなく、`CLI 風の整形済み行` にする

## 6. 出力仕様

### 6.1 run 開始ヘッダー

各 run 開始時に、視認しやすいヘッダーを出力する。

表示項目:

- run 番号
- 開始時刻
- cwd
- model
- reasoning
- fast mode
- thread 情報
- 添付数

表示例:

```text
===== Codex run #12 started =====
time: 2026-03-20 07:41:12
cwd: C:\Users\sgmxk\Desktop\codex
model: gpt-5.4
reasoning: high
fast mode: off
thread: resume 019d07e8-399e-7e02-8eb7-c0db625916d4
attachments: 2 files, 1 image
```

### 6.2 user 入力表示

Codex 本体が動き出す前に、処理対象となる入力を人間向けに出す。

- `user >` 形式で表示
- 長文はプレビュー化して末尾を省略可能
- 添付由来の補助テキストは必要に応じて隠し、要約表記を優先する

表示例:

```text
user > "icon.jpg をインストール時のアイコンにしたい"
```

### 6.3 status 行

内部状態を人間向けラベルへ変換して出力する。

対象:

- queued
- running
- waiting_codex
- completed
- stopped
- error

表示例:

```text
status > queued
status > running
status > waiting for codex
status > completed
```

同じ状態が連続する場合は重複出力しない。

### 6.4 assistant 出力

assistant の出力は JSON を見せず、本文だけ読める形で出す。

区別:

- commentary は `assistant (commentary) >`
- final answer は `assistant >`

方針:

- 可能な限り改行を維持する
- 長文は読みやすいようにブロック表示する
- raw JSON は console log には出さない

表示例:

```text
assistant (commentary) > アイコン生成元と Tauri の bundle 設定を確認します。

assistant >
icon.jpg を元にアイコン一式を再生成し、ビルドし直しました。
```

### 6.5 command 実行表示

command_execution 系イベントは、CLI を見ている感覚に近い行へ変換する。

表示例:

```text
command > npm run tauri:build
command > node --check ui/app.js
```

将来 command 出力まで表示できるようになった場合は、別ブロックとして拡張する。

### 6.6 usage 表示

turn 完了時にトークン使用量があれば短く表示する。

表示例:

```text
usage > in: 247040, cached: 112384, out: 13366
```

### 6.7 error 表示

エラーは 1 行の長い生テキストではなく、診断ブロックとして表示する。

表示項目:

- exit code
- 高レベルな失敗理由
- 必要な stderr 要約

表示例:

```text
error > Codex exited with code 1
reason > unsupported service_tier: flex
stderr > startup websocket prewarm setup failed
```

### 6.8 run 終了フッター

終了時に footer を出して、成功・停止・失敗を明確化する。

表示例:

```text
===== Codex run #12 completed successfully (18s) =====
===== Codex run #13 stopped (4s) =====
===== Codex run #14 failed (2s) =====
```

## 7. 色分け仕様

PowerShell の `Write-Host` 相当の色表現を活用する。

推奨色:

- run header / footer: Cyan
- user: Green
- assistant final: White
- assistant commentary: Gray
- command: Yellow
- status / meta: DarkGray
- error: Red
- usage: Magenta もしくは Blue

色が使えない環境でも、プレーンテキストとして意味が通ることを前提とする。

## 8. ログ構成

### 8.1 raw log

既存の `codex-live.log` を継続利用する。

役割:

- 低レベル診断
- 生の stdout/stderr 追跡
- 想定外イベントの調査

### 8.2 console log

新たに人間向け整形ログを追加する。

候補パス:

- `data/logs/codex-console.log`

役割:

- Developer Console のデフォルト表示先
- 人間向けの live console
- JSON を隠した読みやすい整形出力

### 8.3 原則

- CoDiCoDi の状態管理は従来通り JSON 解析結果を正とする
- raw log は低レベル調査用
- console log は人間向け表示専用

## 9. イベント変換仕様

console log への変換は、以下の入力から行う。

- run 開始時点で CoDiCoDi が持っている session 設定
- Codex CLI の stdout JSON イベント
- stderr 行
- close / cancel / error の終了情報

変換ルール:

- `turn.started` -> `status > waiting for codex`
- `item.completed(agent_message)` -> assistant 表示
- `item.started(command_execution)` -> command 表示
- `turn.completed` -> usage と footer
- cancel -> stopped footer
- 非 0 exit -> error block と failed footer

補足:

- parse 不能な stdout は原則 raw log のみに残す
- 必要なら将来 `debug >` として console log にも出せるよう拡張可能にする

## 10. PowerShell 起動仕様

`Open Developer Console` 押下時の PowerShell は、formatted console を表示する。

要件:

- ウィンドウタイトルは `CoDiCoDi Developer Console`
- UTF-8 を明示設定する
- `Get-Content -Encoding UTF8 -Tail 120 -Wait` で console log を追う

将来拡張:

- `Open Developer Console`
- `Open Raw Developer Log`

の 2 系統に分けられる余地を残す。

## 11. 変更対象案

### 11.1 `server/src/config.js`

追加候補:

- `codexDeveloperConsoleLogPath`

### 11.2 `server/src/codex-adapter.js`

主変更箇所:

- raw log と別に console log の書き込み関数を追加
- run 開始時の整形 header 出力
- user prompt の整形出力
- status / assistant / command / usage / error / footer の変換出力
- PowerShell 起動先を raw log から console log へ変更

### 11.3 `server/src/bridge.js`

原則大きな変更は不要。

必要なら将来的に runtime 情報へ以下を追加可能:

- formatted console 対応可否
- raw / formatted の切り替え可否

### 11.4 `ui/app.js`

第一段階では変更不要。

将来候補:

- `Open Raw Log` ボタン追加
- どちらを開くか選ぶ簡易メニュー追加

## 12. 後方互換性

- `CODEX_DEVELOPER_MODE=true` はそのまま
- 既存 button もそのまま
- CoDiCoDi の queue / restore / attachment / fast mode などには影響しない
- raw log は引き続き残るため、既存デバッグ方法を壊さない

## 13. 失敗時の扱い

- console log 書き込み失敗時も Codex 実行は継続する
- PowerShell 起動失敗時は従来通り UI に feedback を返す
- 想定外イベントは raw log に残す
- 長すぎる本文は console log 側のみプレビュー化可能とする

## 14. テスト観点

### 14.1 手動確認

- Developer Console を開く
- text only の簡単な依頼を 1 件送る
- command 実行を含む依頼を 1 件送る
- 失敗ケースを 1 件発生させる
- Stop を押して停止ケースを見る
- 日本語が文字化けしないことを確認する

### 14.2 確認項目

- header が出る
- user 表示が出る
- status 遷移が読める
- assistant commentary と final が区別できる
- command が読み取れる
- usage が見える
- failed / stopped / completed の違いが明確
- raw log が引き続き残る

### 14.3 回帰確認

- CoDiCoDi の通常チャットが壊れていない
- Restore Chat が壊れていない
- 添付送信が壊れていない
- packaged app でも Developer Console が開く

## 15. 実装優先度

優先順位は以下とする。

1. console log 追加
2. PowerShell 表示先の切替
3. run header / footer / status / error の整形
4. assistant / command の整形
5. raw / formatted の選択 UI は必要になってから

## 16. 推奨方針

まずは Phase 1 として、`formatted console log を追加し、Open Developer Console の既定表示をそちらへ切り替える` のみ実施する。

この構成であれば、

- 既存の CoDiCoDi アーキテクチャを壊さない
- 実装コストが小さい
- 体感上は大きく改善する
- 必要時は raw log にすぐ戻れる

というバランスが取れる。
