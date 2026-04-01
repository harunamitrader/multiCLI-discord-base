# CoDiCoDi 引継ぎメモ 2026-03-20

## 対象プロジェクト
- プロジェクト名: `Codex Discord Connected Display`
- 略称: `CoDiCoDi`
- 作業ディレクトリ: `C:\Users\sgmxk\Desktop\codex\project\codicodi`

## 現在の版
- 現在のソース版: `v0.1.17`
- 反映先:
  - `C:\Users\sgmxk\Desktop\codex\project\codicodi\package.json`
  - `C:\Users\sgmxk\Desktop\codex\project\codicodi\src-tauri\tauri.conf.json`
  - `C:\Users\sgmxk\Desktop\codex\project\codicodi\src-tauri\Cargo.toml`
- 備考:
  - UI 側の `index.html` / `sw.js` 側の version query / cache 名も都度更新している
  - ユーザー要望により、修正作業ごとに version を上げる運用

## 起動方法

### 1. Direct 起動
- ショートカット:
  - `C:\Users\sgmxk\Desktop\CoDiCoDi (Direct).lnk`
- 起動スクリプト:
  - `C:\Users\sgmxk\Desktop\codex\project\codicodi\launch-direct.ps1`
- 用途:
  - release exe を直接起動する確認用
- 注意:
  - 以前は古い AppData 側 bridge を再利用してしまい、旧 UI や `Not found` が出る問題があった
  - 現在は launch 時に stale bridge / 3087 / 3187 listener を止める修正を入れてある

### 2. Dev 起動
- ショートカット:
  - `C:\Users\sgmxk\Desktop\CoDiCoDi (Dev).lnk`
- 起動スクリプト:
  - `C:\Users\sgmxk\Desktop\codex\project\codicodi\launch-tauri-dev.ps1`
- 中身:
  - `npm run tauri:dev`
- 用途:
  - UI / CSS の確認は基本これを使う
- 備考:
  - `tauri build` は遅いので、通常の見た目確認では毎回 build しない方針に切替済み

## 現在までに入っている主な改善

### Developer Console 関連
- `Open Developer Console` と `Open Formatted Console` の 2 系統を用意
- env で developer mode を切り替える方式は廃止し、全ユーザーにボタン表示する方針へ変更
- raw log と formatted console log の 2 本立て
- formatted console の仕様メモ:
  - `C:\Users\sgmxk\Desktop\codex\document\codicodi_developer_console_realistic_view_spec_2026-03-20.md`

### Codex 実行まわり
- `fast mode` の `auto` 問題を修正し、`flex` / `fast` の扱いを整理
- Codex version 表示をキャッシュ依存ではなく実際の `codex --version` ベースに変更
- `v0.116.0` 表示へ修正済み

### セッション復元 / 取り残し状態
- `queued / running / waiting_codex` の stale 状態回復処理を追加
- `Restore Chat` まわりの restore API を追加
- 非ゼロ終了時に最後の assistant メッセージが落ちる問題を修正
- 以前欠落していた `open claw quest` の assistant メッセージ 1 件は手動復元済み

### 添付機能
- Local UI で drag and drop 添付を追加
- `Ctrl+V` による clipboard image / file 添付を追加
- `Add files` 既存導線と同じ validation を通す構成

### アイコン
- `icon.jpg` ベースでアイコン一式を差し替え済み
- Windows 側の icon cache 由来で見え方が古いことはあった

## 現在の UI 方針

### 左パレット
- 幅はかなり細め
- タイトル表記:
  - `Codex Discord`
  - `Connected Display`
  の 2 行
- `CoDiCoDi` の下に version 表示
- 説明文 `A shared workspace...` は削除済み
- セッションカードは:
  - セッション名
  - 最終更新日時
  のみ表示
- 左パレットは独立スクロール

### 右側レイアウト
- 上部に session / Discord channel / action card の並び
- 設定エリアは:
  - `Model` 独立カード
  - その下に `Reasoning` / `Fast mode` / console ボタン系カード
- 右側は:
  - 上部の main scroll area
  - 下部固定 composer
  に分離
- 会話レンダリング時の自動スクロールは削除済み

### ウィンドウサイズ
- 最小サイズは `800x600` に設定済み
- `800x600` までは現行レイアウトを維持する方針

## 直近の修正

### v0.1.16
- top-right action card の幅調整
- 上段 3 カラム維持の再調整
- ただしユーザーから「まだ直っていない」とフィードバックあり

### v0.1.17
- top-right action card をさらに細くする方向で CSS 調整
- desktop モードで window close 時に確認を出すため `beforeunload` を追加
- 今回は source 更新のみで、`tauri build` は未実行
- `node --check` までは通過

## v0.1.17 時点の未確認 / 未解決

### 1. チャット欄の水色背景が途中で切れる
- ユーザーから「まだ直っていない」と報告あり
- main scroll area / chat log / composer 周辺の高さ計算を再確認する必要あり

### 2. top-right action card 幅
- `completed / Restore Chat / Delete Session` のカードを最小限にしたい要望あり
- CSS 調整は入れたが、ユーザー観点ではまだ不十分の可能性あり

### 3. 閉じる時の確認メッセージ
- `beforeunload` は実装済み
- ただし Tauri desktop で実際に期待通り確認ダイアログが出るかは未検証

## 直近で触った主なファイル
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\ui\app.js`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\ui\styles.css`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\ui\index.html`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\ui\sw.js`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\server\src\bridge.js`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\server\src\codex-adapter.js`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\server\src\config.js`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\server\src\http-server.js`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\src-tauri\src\lib.rs`
- `C:\Users\sgmxk\Desktop\codex\project\codicodi\launch-direct.ps1`

## 次チャットで再開しやすい優先確認
1. `CoDiCoDi (Dev)` で `v0.1.17` を起動して、chat 背景切れがまだ再現するか確認
2. top-right action card の横幅をさらに縮める必要があるか視覚確認
3. window close 時の確認ダイアログが Tauri 上で本当に出るか実機確認
4. 問題が取れた段階でのみ `tauri build`

## 補足メモ
- `tauri build` は重いので、日常の UI 微調整は `CoDiCoDi (Dev)` 優先
- ユーザーは「修正のたびに version を更新してほしい」と要望している
- 旧 build / 旧 AppData bridge / service worker cache による見え方ズレが過去に何度も起きたため、表示が古いと感じたらまず起動経路と cache/bridge の取り違えを疑う
