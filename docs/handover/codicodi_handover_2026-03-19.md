# CoDiCoDi 引き継ぎ資料

更新日: 2026-03-20  
対象プロジェクト: CoDiCoDi / Tauri 版 / OSS 公開済みリポジトリ

## 1. 現在の正式名称
- 正式名称: `Codex Discord Connected Display`
- 略称: `CoDiCoDi`
- GitHub リポジトリ: [https://github.com/harunamitrader/codicodi](https://github.com/harunamitrader/codicodi)

## 2. 作業対象フォルダ
- 本番運用中の旧フォルダ:
  - `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge`
- 現在の開発対象 / OSS 公開対象:
  - `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri`

以後の改修は基本的に `codex-dual-input-bridge-tauri` 側で行う。

## 3. Git / GitHub の現状
- リポジトリ URL:
  - [https://github.com/harunamitrader/codicodi](https://github.com/harunamitrader/codicodi)
- ローカルリポジトリ:
  - `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri`
- remote:
  - `origin https://github.com/harunamitrader/codicodi.git`

補足:
- 公開前に履歴を整理し、個人情報や旧名称が残らないよう 1 コミット構成にまとめ直している。
- README、仕様書、SECURITY、CHANGELOG、NOTICE、LICENSE 類は日本語で整備済み。

## 4. Tauri 版の現状
- Tauri ラッパーは動作確認済み。
- アプリ起動時に bridge を自動起動する。
- 起動中は小さい splash 画面を表示する。
- 黒い `node` コンソールは表示しない。
- main UI は Tauri ウィンドウ内で表示される。

生成済み installer:
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\src-tauri\target\release\bundle\nsis\Codex Discord Connected Display_0.1.0_x64-setup.exe`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\src-tauri\target\release\bundle\msi\Codex Discord Connected Display_0.1.0_x64_en-US.msi`

## 5. 主要ドキュメント
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\README.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\SECURITY.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\CHANGELOG.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\NOTICE.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\LICENSE`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\LICENSE.ja.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\docs\SPECIFICATION.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\TAURI_MIGRATION_PLAN.md`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\.env.example`

README 先頭にはヘッダー画像を入れている。
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\header.jpg`

## 6. 実装済みの主要機能
- local UI と Discord から同じ Codex セッションを共有
- セッション作成 / rename / delete / restore
- Discord の `/codex` slash command 群
- model / reasoning / fast mode 切り替え
- Stop による生成中断
- UI と Discord の双方向ミラー
- Discord からの入力は最終メッセージのみ reply
- 途中メッセージは通常投稿
- `Working` と `Completed` の進捗表示
- 画像 / ファイル添付対応
- Discord チャンネル選択 UI
- Tauri デスクトップ化
- ファイル監視と Discord ファイルログ通知

## 7. 直近で入った重要な仕様

### 7-1. queue 通知
同じセッションで先行ターンが走っているとき、後続メッセージが順番待ちになることを表示するようにした。

Discord:
- 次の順番なら `☑ Queued as next turn.`
- さらに後ろなら `☑ Queued. N turns ahead.`

local UI:
- 入力欄の下に控えめな queued メッセージを数秒表示

関連ファイル:
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\bridge.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\http-server.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\discord-adapter.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\ui\index.html`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\ui\app.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\ui\styles.css`

### 7-2. fast mode エラー修正
`fast off` 時に `service_tier="auto"` を渡していたため、Codex CLI `0.116.0` でエラーになっていた。

修正内容:
- `off` は `flex`
- `on` は `fast`
- 既存 DB に残っている `auto` も `flex` 扱いへ補正

修正ファイル:
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\config.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\bridge.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\db.js`
- `C:\Users\sgmxk\Desktop\codex\project\codex-dual-input-bridge-tauri\server\src\store.js`

## 8. Codex CLI の現状
ローカルで確認した現在の Codex CLI:
- `OpenAI Codex (v0.116.0)`

確認結果:
- `npm` 上の最新公開版は `0.116.0`
- GitHub Releases で見えた最新の安定版ノートは `0.115.0`
- そのため、`0.116.0` の完全な公式 changelog は未確認

今のツールに影響しそうな点:
- `service_tier` は `fast` / `flex` 前提
- `--profile` 周りは `0.115.0` で改善
- `--search` はモデル依存の挙動差があり得る
- Windows sandbox 系の内部変更はあるが、今は bypass 寄りなので直撃は小さめ

## 9. push 前に行った公開安全確認
- `.env` は Git 管理外
- `data/` は Git 管理外
- `node_modules/` は Git 管理外
- `src-tauri/target/` は Git 管理外
- 旧名称の installer / msi / exe / fingerprint / 起動ログは削除済み
- `C:\Users\sgmxk` などの個人パス、旧 identifier、旧名称が履歴に残らないよう整理済み

公開向けに調整済みの例:
- `.env.example` の workdir を汎用例に変更
- `server/src/config.js` の既定 workdir を `os.homedir()` ベースへ変更
- Tauri identifier を `io.github.harunamitrader.codicodi` に変更

## 10. 現時点での注意点
- Tauri 版はローカルの Node.js と Codex CLI を前提にしている
- 自動更新は未実装
- Tauri 版のスタートアップ最適化はまだ余地あり
- Discord Bot Token やフォルダ監視設定は利用者が自分で用意する必要がある
- security 面では、README と SECURITY.md で注意喚起を強めている

## 11. 次のチャットで再開しやすい候補
1. UI / UX の微調整
2. Tauri 版の配布改善
3. drag & drop 添付
4. 設定画面の整理
5. Discord 通知文面の改善
6. CLI 更新に伴う互換性再確認
7. GitHub Releases と installer 配布導線の整備

## 12. 次チャットへの最短メモ
- 作業対象は `codex-dual-input-bridge-tauri`
- 正式名称は `Codex Discord Connected Display`
- 略称は `CoDiCoDi`
- GitHub はすでに公開済み
- Tauri 版は起動確認済み
- 直近の重要修正は:
  - queue 通知追加
  - fast mode の `auto -> flex` 修正
  - Codex CLI `0.116.0` の影響確認
