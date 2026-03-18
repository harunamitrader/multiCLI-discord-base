# Tauri 移行計画

## 目的

既存の bridge を軽量なデスクトップラッパーで包み、`Codex Discord Connected Display (CoDiCoDi)` として扱いやすくすること。

- デスクトップから 1 回の起動で使える
- ローカル bridge server を自動起動する
- UI を専用ウィンドウで開く
- 既存の HTML / CSS / JS UI を大きく書き換えない
- 将来の drag & drop 添付にもつなげやすい形にする

## 方針

最初は薄い Tauri ラッパーにする。

- 既存の Node bridge はそのまま使う
- Tauri 起動時に bridge を起動する
- `http://127.0.0.1:3187/api/health` が返るまで待つ
- 準備完了後に UI を専用ウィンドウで開く
- 終了時は自分で起動した child bridge だけ止める

## フェーズ

1. 環境準備
   - Rust / cargo 導入
   - Tauri CLI 追加
   - `src-tauri` ひな形作成

2. 薄いラッパー実装
   - Tauri 設定作成
   - `node server/src/index.js` 起動
   - health endpoint 待機
   - メインウィンドウ表示

3. 配布向け調整
   - アプリ名とアイコン
   - 二重起動回避
   - ログ保存
   - 起動中スプラッシュ

4. 今後の拡張候補
   - 必要なら localhost 依存をさらに減らす
   - 必要ならネイティブ drag & drop を追加する

## 今回の実装範囲

今回の段階では、まず次を成立させる。

- Tauri から既存 bridge を起動できる
- UI が専用ウィンドウで開く
- 終了時に child process を片付ける

この段階では UI の大幅な作り直しはしない。

## 現在の状態

- 本番用とは別に、移行作業用コピーを作成済み
- Rust と Tauri CLI の導入済み
- `src-tauri` の scaffold 追加済み
- Tauri は現在、次の挙動を行う
  - 既存 bridge が起動済みなら再利用
  - 起動していなければ `node server/src/index.js` を起動
  - `/api/health` を待機
  - 準備完了後にメインウィンドウを表示
  - 起動中はスプラッシュを表示
  - 自分で起動した child process だけ終了時に停止
- 移行用コピーは `3187` 番ポートに分離済み
- `tauri:dev` により次を確認済み
  - `127.0.0.1:3187` で bridge 起動
  - `/api/health` が `{"ok":true}` を返す
  - Tauri ランタイムと WebView が起動
- `tauri:build` により次を確認済み
  - MSI bundle 作成
  - NSIS setup exe 作成
  - release exe 作成
- 実機確認済み
  - スプラッシュ表示
  - 余分な黒いコンソールなし
  - メイン UI 起動成功

## 現在の制約

現時点のラッパーは、ターゲット PC に次が入っている前提。

- Node.js
- Codex CLI

軽量さ優先のためこの形にしているが、非開発者向け配布を強めるなら将来的には次のどちらかが必要。

- portable Node の同梱
- Node bridge のネイティブ移植

## 補助スクリプト

- `scripts/install-tauri-build-tools.ps1`
  - Build Tools の導入補助
- `scripts/run-tauri-dev.ps1`
  - `tauri info` と `tauri:dev` 実行補助
