# CoDiCoDi向け Discord Plugin 流用メモ

作成日: 2026-03-20

対象:
- 参照元: `C:\Users\sgmxk\Desktop\codex\project\claude-plugins-official\external_plugins\discord`
- 想定流用先: `C:\Users\sgmxk\Desktop\codex\project\codicodi`

## 結論

Claude Code 用 Discord plugin は、そのまま CoDiCoDi に移植するよりも、Discord 側の有用ロジックを部分流用する価値が高い。

特に流用候補として有望なのは以下:
- DM / ギルド channel のアクセス制御
- mention 判定
- 長文 chunking
- 添付ファイルまわりの安全策
- オンデマンド添付取得の考え方

一方で、MCP server と Claude 専用 skill / channel 連携は CoDiCoDi の構成と噛み合わないため、基本的には流用対象外。

## 参照した主なコード位置

Claude plugin 側:
- `server.ts:212` `gate`
- `server.ts:272` `isMentioned`
- `server.ts:303` `checkApprovals`
- `server.ts:349` `chunk`
- `server.ts:381` `fetchAllowedChannel`
- `server.ts:393` `downloadAttachment`
- `server.ts:411` `safeAttName`

CoDiCoDi 側:
- `server/src/discord-adapter.js:9` `splitMessage`
- `server/src/discord-adapter.js:314` `isAllowedTarget`
- `server/src/discord-adapter.js:982` `handleMessage`
- `server/src/discord-adapter.js:1048` Discord 添付保存
- `server/src/discord-adapter.js:1074` bridge -> Discord 反映

## そのまま流用しやすい候補

### 1. Mention 判定ロジック

参照元:
- `server.ts:272`

内容:
- bot への通常 mention
- bot の直近送信メッセージへの reply
- 任意 regex パターンでの mention 扱い

有用性:
- 今の CoDiCoDi は guild / channel ID の許可判定はあるが、会話トリガー条件はかなり単純
- `reply to bot message` を implicit mention とみなすと、Discord 上の使い勝手がかなり上がる

CoDiCoDi での主な当て先:
- `server/src/discord-adapter.js`

メモ:
- `recentSentIds` の考え方も合わせて移すと効果が出やすい

### 2. 長文 chunking 改善

参照元:
- `server.ts:349`

内容:
- 2000 文字上限前提
- `newline` 優先で自然な切れ目を探す
- `length` モードも残す

有用性:
- CoDiCoDi の `splitMessage()` は改行優先のみの簡易版
- Discord 送信の見た目改善と、途中で不自然に切れる問題の軽減が期待できる

CoDiCoDi での主な当て先:
- `server/src/discord-adapter.js:9`

メモ:
- 将来的に設定化して `replyToMode` 相当も持てるとよい

### 3. 添付名の安全化

参照元:
- `server.ts:411`

内容:
- 添付名に含まれる `[]`, 改行, `;` などの区切り破壊文字を無害化

有用性:
- Discord 投稿内容やログ整形時に、添付名由来で表示やメタ表現が崩れるのを防げる

CoDiCoDi での主な当て先:
- `server/src/discord-adapter.js`
- 必要なら `server/src/attachment-service.js`

### 4. 送信対象の安全チェックという考え方

参照元:
- `server.ts:381` `fetchAllowedChannel`

内容:
- outbound 送信でも「許可済み channel か」を再チェック

有用性:
- CoDiCoDi は session に紐づく Discord channel 前提だが、将来機能追加で送信先指定が増えると必要になる
- 「受信だけでなく送信も許可済み対象に限定する」方針は安全

CoDiCoDi での主な当て先:
- `server/src/discord-adapter.js`

## 改造すれば有用な候補

### 5. Pairing / Allowlist / Disabled のアクセス制御

参照元:
- `server.ts:212`
- `ACCESS.md`

内容:
- DM policy を `pairing / allowlist / disabled` で管理
- 初回 DM は pairing code を返し、許可後に allowlist へ追加
- guild channel は個別 opt-in

有用性:
- CoDiCoDi の今の `DISCORD_ALLOWED_GUILD_IDS` / `DISCORD_ALLOWED_CHANNEL_IDS` より柔軟
- 自分専用 bot にしたい時の運用がかなり楽になる

必要な改造:
- `.claude/channels/discord/access.json` 前提を CoDiCoDi の config / data 方式へ置換
- skill ベース運用ではなく、CoDiCoDi UI または slash command で管理する形に変更

CoDiCoDi での主な当て先:
- `server/src/discord-adapter.js`
- 必要なら `server/src/store.js` か別 access store

メモ:
- 価値は高いが、設定保存設計まで含めるため中規模変更

### 6. 承認ファイル polling の考え方

参照元:
- `server.ts:303`

内容:
- pairing 承認をファイル経由で非同期受け取りし、Discord DM に確認メッセージを返す

有用性:
- CoDiCoDi でも UI / 別プロセス / 将来の管理ツールから承認イベントを渡す仕組みとして参考になる

必要な改造:
- そのままファイル polling を採用する必要は薄い
- CoDiCoDi なら HTTP API または DB ベースの方が自然

判断:
- 実装方式そのものより、「承認イベントを非同期で受ける設計」の参考として有用

### 7. 添付のオンデマンド取得

参照元:
- `server.ts:393`
- `README.md` の Attachments 節

内容:
- 添付は受信時に即 download せず、必要になった時だけ取得

有用性:
- CoDiCoDi は現状 Discord 添付を受信時に即保存している
- 不要な画像や大きなファイルが多い環境では、無駄な I/O や保存量を減らせる

必要な改造:
- 現在の `attachments.saveDiscordAttachments()` 前提から、メタ保存 + 必要時 download に設計変更
- UI / prompt 生成側も「未取得添付」を扱える必要あり

判断:
- 将来の最適化候補として有望
- 直近の優先度は中くらい

### 8. Discord 履歴取得機能

参照元:
- `server.ts:570` `fetch_messages`

内容:
- 最近のメッセージを oldest-first で取得
- 添付数を簡易表示

有用性:
- CoDiCoDi でも「この channel の最近の流れを見たい」「古い投稿を参照したい」機能に展開できる

必要な改造:
- Claude tool ではなく、slash command かローカル UI 機能として設計し直す必要がある

判断:
- 直接移植ではなく、将来機能の参考

## 見送り寄りの候補

### 9. MCP server 本体

参照元:
- `server.ts:415`
- `server.ts:433`

理由:
- これは Claude Code の channel / tool 呼び出し前提
- CoDiCoDi は `BridgeService -> CodexAdapter` で動いており、MCP tool server として組み直す必然性が薄い

判断:
- 基本的に流用しない

### 10. Claude plugin skill 群

参照元:
- `.claude-plugin/plugin.json`
- `skills/access/SKILL.md`
- `skills/configure/SKILL.md`

理由:
- `~/.claude/...` 前提
- Claude の plugin / skill UX に強く依存
- CoDiCoDi では UI, HTTP API, slash command の方が自然

判断:
- 仕様参考にはなるが、実装流用はしない

## CoDiCoDi へ取り込むなら優先順位

### 優先度 高

1. mention 判定強化
2. chunking 改善
3. 添付名などの安全化

### 優先度 中

1. pairing / allowlist / disabled
2. guild channel ごとの opt-in
3. reply-to-bot を implicit mention とみなす運用

### 優先度 低

1. オンデマンド添付取得
2. 履歴取得
3. 承認ファイル polling を参考にした外部承認フロー

## 実装時の注意

- Claude plugin 側は「Claude に道具を渡す」設計
- CoDiCoDi は「Codex CLI の外側に broker を置く」設計

この違いがあるため、ロジック単位では流用できても、モジュール単位のコピペ移植は破綻しやすい。

実装方針としては、以下が安全:
- 方針を借りる
- 小さな pure function を移植する
- access policy は CoDiCoDi 向けに再設計する
- MCP / skill 依存部分は捨てる

## 短いまとめ

この plugin で一番おいしいのは「Discord bot としての成熟した振る舞い」であって、「Claude plugin という形そのもの」ではない。

CoDiCoDi に取り込む価値が高いのは:
- access policy
- mention / reply 判定
- chunking
- attachment safety

逆にそのまま使いにくいのは:
- MCP server
- Claude skill
- `.claude` 配下前提の運用

後で実装検討する場合は、まず `mention 判定 + chunking + access policy` の順で見るのがよい。
