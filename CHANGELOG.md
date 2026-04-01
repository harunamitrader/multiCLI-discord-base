# 変更履歴

このファイルでは、このプロジェクトの主な変更を記録します。

## 0.1.65 - 2026-04-01

- スケジュール管理を追加し、cron で既存セッションまたは新規セッションへ定期送信できるよう改善
- スケジュール一覧・cron 日本語表示・稼働状態表示・既定値保存をローカル UI に追加
- セッションごと / スケジュール既定値ごとに、`CODEX_WORKDIR` 配下の working directory を選択できるよう改善
- Windows のフォルダ picker と、作業ディレクトリ変更時の安全チェックを追加
- `launch-browser.cmd` / `launch-browser.ps1` / `codicodi-server.cmd` / `scripts/start-server.cmd` を追加し、ブラウザ起動とサーバー起動を補助
- composer に `Enter Send` トグルを追加し、右側操作ボタン列とセッション / スケジュール表示を再調整
- HTML / service worker / manifest / package version を `0.1.65` に更新

## 0.1.46 - 2026-03-29

- セッションの `Review` ボタンと UI 側の review 実行処理を削除
- `/api/sessions/:id/review` と bridge / Codex adapter の review 専用実装を削除
- README / 仕様書に、review 機能は現時点で未提供である旨を追記
- HTML / service worker / app version を `0.1.46` に更新

## 0.1.41 - 2026-03-22

- composer 内スクロール時に右側ボタン列が本当に上端へ固定されるよう、sticky 要素を上寄せに修正
- HTML / service worker / app version を `0.1.41` に更新

## 0.1.40 - 2026-03-22

- 右側操作ボタンの並び順を `Add files → Send → Stop` に調整
- `Stop` ボタンだけ文字サイズは維持したまま高さを少し縮小
- HTML / service worker / app version を `0.1.40` に更新

## 0.1.39 - 2026-03-22

- 下部 composer パレットが内側スクロールしたときも、右側の操作ボタン列が上側に残るよう sticky 化
- HTML / service worker / app version を `0.1.39` に更新

## 0.1.38 - 2026-03-22

- 下部固定 composer パレットの高さを固定し、内容が増えたときはパレット全体で内側スクロールするよう調整
- 添付ファイル表示時も textarea が 4 行未満に縮まらないよう最小高さを保証
- HTML / service worker / app version を `0.1.38` に更新

## 0.1.37 - 2026-03-22

- composer パレット全体のサイズは維持したまま、左の入力カードを右ボタン列の高さまで使うよう再調整
- textarea を flex で伸ばし、白いカード内の縦幅を入力面積として最大化
- HTML / service worker / app version を `0.1.37` に更新

## 0.1.36 - 2026-03-22

- 右側ボタン列に合わせて左の入力カードが縦に引き伸ばされないよう、composer grid の stretch を解除
- 入力欄下の未使用に見える余白を縮小
- HTML / service worker / app version を `0.1.36` に更新

## 0.1.35 - 2026-03-22

- 添付一覧も composer feedback もないときは入力欄下部の footer を自動で畳み、未使用の空帯が見えないよう調整
- HTML / service worker / app version を `0.1.35` に更新

## 0.1.34 - 2026-03-22

- `Add files` の文字サイズは維持しつつ、ボタン本体の高さと内側余白だけを縮小
- HTML / service worker / app version を `0.1.34` に更新

## 0.1.33 - 2026-03-22

- 右側縦並びレイアウトは維持したまま、`Add files` ボタンだけ高さと文字サイズを縮めて軽い見た目に調整
- HTML / service worker / app version を `0.1.33` に更新

## 0.1.32 - 2026-03-22

- composer 全体のサイズ感を戻し、入力欄を左・`Add files / Stop / Send` を右側縦並びへ再配置
- textarea の最小高さを元寄りに戻しつつ、添付一覧とフィードバックは左カラム下部に維持
- HTML / service worker / app version を `0.1.32` に更新

## 0.1.31 - 2026-03-22

- 入力欄の縦幅を優先し、textarea の最小高さを引き上げて複数行を扱いやすく調整
- `Add files` / `Stop` / `Send` の操作帯を少し圧縮し、入力面積に寄せたバランスへ微調整
- HTML / service worker / app version を `0.1.31` に更新

## 0.1.30 - 2026-03-22

- `Add files` を composer 下部の右側操作エリアへ移動し、送信操作と同じ側に集約
- `Stop` / `Send` を入力欄の下フッター内に収め、textarea の横幅をフルに使えるよう再配置
- HTML / service worker / app version を `0.1.30` に更新

## 0.1.29 - 2026-03-22

- 入力欄カードの下部にフッター境界を追加し、`Add files` が白いパレット内に見えるよう調整
- composer の白いカード影と textarea 高さを微調整して入力領域を維持したまま一体感を改善
- HTML / service worker / app version を `0.1.29` に更新

## 0.1.26 - 2026-03-21

- `CODEX_DEVELOPER_MODE` を廃止し、開発者コンソールを常時利用可能に変更
- `Open Formatted Console` を削除し、raw の `Open Developer Console` のみに一本化
- formatted console 用の server 側ログ生成ロジックを削除
- README / 仕様書 / `.env.example` から関連設定と説明を整理
- HTML / service worker / app version を `0.1.26` に更新

## 0.1.27 - 2026-03-22

- `Select Channel` に `Not linked` を追加し、UI から Discord チャンネル紐付けを解除できるよう改善
- `discord-bind` API が `channelId=null` を受け取れるように修正
- HTML / service worker / app version を `0.1.27` に更新

## 0.1.28 - 2026-03-22

- 入力パレットを再配置し、`Add files` を入力欄フッター内へ移動
- `Stop` / `Send` を右側の縦積み列へ変更し、入力欄の横幅を拡大
- `Add files` ボタンの配色を調整して視認性を改善
- HTML / service worker / app version を `0.1.28` に更新

## 0.1.24 - 2026-03-21

- PWA のインストール名を `CoDiCoDi` に統一
- ブラウザタブのタイトルを `CoDiCoDi` に変更
- Tauri 版の product name / main window title / splash title を `CoDiCoDi` に統一
- manifest / HTML / service worker の version と cache key を更新

## 0.1.25 - 2026-03-21

- `CODEX_DEVELOPER_MODE=false` のときは開発者コンソールのボタンを UI で非表示に修正
- 開発者コンソール起動失敗時に `message` も拾って表示するようにし、`Request failed` だけにならないよう改善
- HTML / service worker / app version を `0.1.25` に更新

## 0.1.23 - 2026-03-21

- NSIS installer に `icons/icon.ico` を明示指定し、setup exe 側でもアプリアイコンを使うよう調整
- バージョン番号と PWA キャッシュを `0.1.23` に更新
- `npm run tauri:build` で `0.1.23` の MSI / NSIS installer を再生成

## 0.1.22 - 2026-03-21

前回の GitHub 公開版 (`0.1.0`) からの主な更新:

- セッション復旧まわりを改善
  - `Restore Chat` で DB から会話履歴を再読込できるよう整理
  - アプリ再起動時に `queued` / `running` / `waiting_codex` のまま残った古いセッションを自動で `stopped` に復旧
  - UI / Discord の両方で、キューに積まれたターン数を分かるように改善
- 開発者向けログ表示を追加
  - `Open Developer Console` で Codex CLI の raw log を追跡
  - `Open Formatted Console` で CLI 風の読みやすい要約表示を追跡
  - UI にアプリ版 / Codex 版 / 作業ディレクトリ表示を追加
- ローカル UI を改善
  - メッセージ入力欄の下固定レイアウトに変更
  - Active Session / 設定 / チャットをまとめてスクロールできるよう調整
  - 会話エリア背景の途切れや composer 周辺の配色を調整
  - 添付ファイルの drag & drop / paste / 個別削除に対応
- Tauri デスクトップ版を改善
  - ウィンドウを閉じるときに確認ダイアログを表示
  - 起動前に残留 bridge process や競合ポートを片付ける処理を追加
  - 最小ウィンドウサイズ設定と UI の version 連動を追加
- 運用まわりを整理
  - service tier の既定値を `flex` に統一し、既存 DB 値も正規化
  - アプリアイコン一式を更新
  - `launch-direct.ps1` / `launch-tauri-dev.ps1` を追加
  - `.env.example` / README / 仕様書を更新

## Unreleased

今後の改修候補:

- デスクトップ配布まわりの追加整備
- drag & drop 添付の改善
- 運用上の安全対策の強化
- ドキュメント拡充

## 0.1.0 - 2026-03-18

`Codex Discord Connected Display (CoDiCoDi)` としてのオープンソース公開向け初回スナップショット。

この時点で含まれている主な内容:

- ローカル UI と Discord の共有 Codex セッション
- SQLite によるセッション・イベント保存
- セッションごとの model / reasoning / fast mode 切り替え
- ローカル UI でのセッション管理
- `/codex` 系の Discord slash command
- Discord 側の進捗表示と最終返信制御
- 画像・ファイル添付対応
- フォルダ監視による Discord ファイルログ通知
- ブラウザ用 PWA 対応
- Tauri デスクトップラッパー
  - bridge 自動起動
  - 起動時スプラッシュ表示
  - 余分な黒いコンソールを出さない
  - installer ビルド確認済み
