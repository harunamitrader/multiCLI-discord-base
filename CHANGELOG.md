# 変更履歴

このファイルでは、このプロジェクトの主な変更を記録します。

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

## Unreleased

今後の改修候補:

- デスクトップ配布まわりの追加整備
- drag & drop 添付の改善
- 運用上の安全対策の強化
- ドキュメント拡充
