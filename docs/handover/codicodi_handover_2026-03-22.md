# CoDiCoDi 引継ぎメモ (2026-03-22)

## 作業場所

- 旧: `C:\Users\sgmxk\Desktop\codex`
- 新: `G:\マイドライブ\AI\codex`
- 対象 repo: `G:\マイドライブ\AI\codex\project\codicodi`

次チャットでは、上の新しいパスを前提に作業を再開すること。

## Git 状態

- HEAD: `8672be7` (`Update README onboarding flow`)
- `package.json` / `src-tauri/Cargo.toml` の現在 version: `0.1.41`
- 未 push のローカル変更あり

変更済みファイル:

- `.env.example`
- `CHANGELOG.md`
- `README.md`
- `docs/SPECIFICATION.md`
- `package-lock.json`
- `package.json`
- `server/src/bridge.js`
- `server/src/codex-adapter.js`
- `server/src/config.js`
- `server/src/http-server.js`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `ui/app.js`
- `ui/index.html`
- `ui/manifest.webmanifest`
- `ui/styles.css`
- `ui/sw.js`

未追跡ファイル:

- `icon.jpg`
- `launch-browser.cmd`
- `launch-browser.ps1`

## 直近の主なローカル変更

- PWA / ブラウザタブ / Tauri 表示名を `CoDiCoDi` に統一
- `CODEX_DEVELOPER_MODE` を廃止し、`Open Developer Console` を常時利用可能化
- `Open Formatted Console` を削除
- `Select Channel` から `Not linked` に戻せるようにした
- 下部固定 composer の UI を継続調整中

## composer の現在地点

現在の意図:

- 入力欄は左
- 右側に `Add files -> Send -> Stop`
- `Stop` は他ボタンより少し低い
- 添付が増えても入力欄は最低 4 行を維持
- 下部固定パレットは高さ固定で、収まりきらないときはパレット内スクロール
- 右側ボタン列はスクロール時に上固定される想定

ただし、ユーザーの最新報告では:

- 「ボタンが上に固定されてない」

この点は `ui/styles.css` で `composer-actions` に `position: sticky; top: 0;` を入れたうえで、
さらに `align-self: start` / `justify-content: flex-start` へ調整済み。
次チャットでは、実画面で sticky が想定どおり効いているかを最優先で再確認すること。

## browser 起動ショートカット関連

- `launch-browser.cmd`
- `launch-browser.ps1`

はローカル作成済みだが未追跡。
必要なら repo に入れるか、不要なら除外するかを判断すること。

## 注意

- 以前、ユーザーが共有した `.env` スクリーンショットに Discord Bot Token が写っていた。
  まだ rotate していなければ再生成を案内した方がよい。
- `src-tauri/target` はビルド生成物なので、削除しても再生成可能。

## 次チャット開始用メモ

次チャットではまず:

1. `G:\マイドライブ\AI\codex\project\codicodi` を作業ディレクトリとして確認
2. `git status --short` でローカル変更を再確認
3. composer の sticky 挙動を確認
4. 必要ならそのまま修正継続
