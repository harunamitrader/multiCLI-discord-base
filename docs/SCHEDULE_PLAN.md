# Codicodi 定期実行機能 — 実装計画

## 概要

Antigravity Discord Bot と cli-prompt-cron の定期実行方式を踏襲し、Codicodi に定期実行（cron）機能を追加する。

- ファイルベース管理（`data/schedules/*.json`）
- node-cron + Chokidar（ホットリロード）
- SKILL.md による自然言語管理（スラッシュコマンドは使わない）
- 指定セッションにプロンプトを送信して実行
- ローカル UI + Discord 両方に結果表示

## ジョブJSON形式

```json
// data/schedules/morning-report.json
{
  "cron": "0 9 * * *",
  "prompt": "今日のタスクを整理して",
  "session": "morning-work",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `cron` | o | cron式（5フィールド） |
| `prompt` | o | Codex に送るテキスト |
| `session` | | セッション名 or ID。省略時はアクティブセッション |
| `timezone` | | デフォルト `Asia/Tokyo` |
| `active` | | false で一時停止（デフォルト true） |

## 実行フロー

```
data/schedules/*.json
    ↓ Chokidar ホットリロード
bridge サーバー (node-cron, JST)
    ↓ cron 発火
セッション解決（指定 or アクティブ）
    ↓
既存メッセージパイプラインにprompt送信
    ↓
Codex 応答 → ローカルUI + Discord 同時表示
    ↓
Discord通知: "⏰ ジョブ「name」実行: `prompt`"
    ↓
実行ログ記録
```

## 実装箇所

### 新規ファイル

| ファイル | 内容 |
|---|---|
| `server/src/scheduler.js` | node-cron + Chokidar。Antigravityの`scheduler.js`を移植・改修 |
| `skills/schedule-manager/SKILL.md` | 自然言語ジョブ管理スキル |

### 既存ファイル変更

| ファイル | 変更内容 |
|---|---|
| `server/src/index.js` | scheduler をimport、初期化 |
| `server/src/bridge.js` | スケジュール発火時のメッセージ送信関数を公開 |
| `server/src/http-server.js` | `/api/schedules` CRUD エンドポイント追加 |
| `ui/index.html` | サイドバーに「スケジュール」ボタン、メインパネルにスケジュールビュー追加 |
| `ui/app.js` | スケジュール一覧の表示・編集ロジック |
| `ui/styles.css` | スケジュールビュー用スタイル |

### scheduler.js 主要関数

| 関数 | 用途 |
|---|---|
| `init(triggerCallback)` | 初期化。発火時コールバック登録 + restoreJobs + Chokidar開始 |
| `addJob(cronExpr, prompt, name, session)` | JSONファイル作成 |
| `removeJob(name)` | ファイル削除 |
| `listJobs()` | 全ジョブ一覧（メタ情報付き） |
| `restoreJobs()` | 起動時に全ジョブ読み込み |
| `stopAll()` | シャットダウン時に全停止 |

### API エンドポイント

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/schedules` | ジョブ一覧 |
| POST | `/api/schedules` | ジョブ作成 |
| PATCH | `/api/schedules/:name` | ジョブ更新 |
| DELETE | `/api/schedules/:name` | ジョブ削除 |

### ローカルUI

サイドバーに「スケジュール」ボタン追加。クリックでメインパネルがスケジュール一覧ビューに切り替わる。

- ジョブカード一覧（名前、cron、セッション、状態）
- インライン編集（cron、プロンプト、セッション）
- 停止/再開ボタン
- 次回実行時刻表示

### SKILL.md

```markdown
## 定期実行ジョブの管理

ジョブファイルは data/schedules/ に配置する。

### できること
- 追加: JSONファイルを作成（ファイル名 = ジョブ名）
- 編集: 既存JSONを更新
- 停止: active を false に変更
- 再開: active を true に変更
- 削除: ファイルを削除
- 一覧: data/schedules/ のファイルを読む

### セッション指定
- session フィールドにセッション名を記載
- 省略時はアクティブセッションで実行

### やってはいけないこと
- data/schedules/ 以外のファイルを変更しない
- JSONファイル以外を作成しない
```

## Antigravity からの踏襲

- ファイルベース管理（1ファイル = 1ジョブ）
- Chokidar ホットリロード（再起動不要）
- SKILL.md で自然言語管理
- スラッシュコマンドは使わない

## Antigravity との違い

| | Antigravity | Codicodi |
|---|---|---|
| 実行方式 | CDP経由でメッセージ注入 | bridge の既存パイプラインにプロンプト送信 |
| セッション | 1つ（現在のチャット） | 指定可能（session フィールド） |
| フィールド名 | `message` | `prompt` |
| 通知先 | Discord のみ | Discord + ローカルUI 両方 |
| タイムゾーン | JST 固定 | フィールド指定（デフォルト JST） |
| UI | なし | ローカルUI にスケジュール一覧 |

## やらないこと（初期実装）

- スラッシュコマンド追加
- タイムアウト/強制停止（`/codex stop` で対応可能）
- 実行結果のファイル保存
- cli-prompt-cron との連携
