# multiCLI-discord-base 実装済み機能の確認チェックリスト

更新日時: 2026-05-03 05:48 JST

対象リポジトリ:

- `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base`

目的:

- 今このリポジトリで「すでに実装されている機能」を、非エンジニアでも確認しやすい単位に分解する
- あなたが 1 機能ずつ見て「本当に動くか」を順番に確認できるようにする
- 各項目ごとに「何ができるか」「どう試すか」「どうなれば OK か」を書く

## 先に読むメモ

1. このチェックリストは「おすすめ確認順」で並べています。上から順に見るのがおすすめです。
2. まずは **ローカル UI だけで確認できる項目** を先に見て、そのあと Discord や高度機能に進むと楽です。
3. Discord、Git、CLI ログインが必要な項目は、その前提が整っている時だけ確認してください。
4. 各項目は「その機能だけ」を見る前提で書いています。うまくいかなかったら、その番号を不具合メモの単位にすると整理しやすいです。

## 共通の事前準備

1. `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\start-multiCLI-discord-base.bat` を起動する
2. ブラウザで `http://127.0.0.1:3087/multiCLI-discord-base.html` を開く
3. 使いたい CLI にログイン済みか確認する
4. 必要なら強制リロードする
   - Windows: `Ctrl + Shift + R`

---

## 1. 起動バッチでサーバーと画面が立ち上がる

- **何ができるか**
  - ダブルクリックや PowerShell 実行で、サーバー起動とブラウザ表示までまとめて始められます。
- **確認方法**
  1. `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\start-multiCLI-discord-base.bat` を実行する
  2. ブラウザが自動で開くか確認する
  3. 画面が白紙ではなく、UI が表示されるか確認する
- **OK の目安**
  - UI が開き、workspace 作成ボタンや Chat / Settings / Agents が見える

## 2. workspace を新規作成できる

- **何ができるか**
  - 作業単位となる workspace を作れます。これは「案件ごとの箱」のようなものです。
- **確認方法**
  1. 左 sidebar の `＋ workspace 作成` を押す
  2. 名前を入れて作成する
  3. 作った workspace が左 sidebar に追加されるか確認する
- **OK の目安**
  - エラーなく作成でき、一覧に新しい workspace が出る

## 3. agent が 1 つだけなら親 agent が決まりやすい

- **何ができるか**
  - agent 定義が 1 つだけの時、workspace 作成時に「この agent を親にする」が自然に決まる設計です。
- **確認方法**
  1. `C:\Users\sgmxk\Desktop\AI\repos\github\harunamitrader\multiCLI-discord-base\config\agents.json` を 1 agent 構成にする
  2. 新しい workspace を作る
  3. Settings か sidebar 表示で親 agent を確認する
- **OK の目安**
  - 親 agent が空欄にならず、作成後すぐ使える状態になる

## 4. workspace は左 sidebar に単一リストで並ぶ

- **何ができるか**
  - 以前の active / inactive 分割ではなく、今は 1 本の一覧で並びます。
- **確認方法**
  1. 複数の workspace を作る
  2. 左 sidebar を見る
  3. `active workspaces` / `inactive workspaces` の分割見出しがないか確認する
- **OK の目安**
  - workspace が 1 本の一覧として並んでいる

## 5. workspace の並び替えが保存される

- **何ができるか**
  - 左 sidebar 上で workspace の順番を変えて、その順番を維持できます。
- **確認方法**
  1. 左 sidebar のドラッグハンドルで workspace の順番を入れ替える
  2. ページを再読み込みする
  3. 並び順が保たれているか確認する
- **OK の目安**
  - リロード後も同じ順番で表示される

## 6. child agent を workspace に追加できる

- **何ができるか**
  - 1 つの workspace の中に、親 agent 以外の補助 agent を追加できます。
- **確認方法**
  1. workspace の accordion を開く
  2. child agent 追加 UI を使って別 agent を加える
  3. agent card が増えるか確認する
- **OK の目安**
  - 親 agent の下に child agent が追加される

## 7. child agent を workspace から外せる

- **何ができるか**
  - 追加した child agent をその workspace から外せます。
- **確認方法**
  1. child agent がある workspace を開く
  2. 該当 agent の削除ボタンを押す
  3. 一覧から消えるか確認する
- **OK の目安**
  - child agent だけが外れ、workspace 自体は残る

## 8. agent card に terminal 状態が表示される

- **何ができるか**
  - 各 agent が「起動前」「起動中」「稼働中」「入力待ち」「エラー」のどれかを sidebar 上で見られます。
- **確認方法**
  1. workspace の accordion を開く
  2. 各 agent card の status badge を見る
  3. Start 前後や prompt 実行中で表示が変わるか確認する
- **OK の目安**
  - 状態に応じて badge が変化する

## 9. 未起動 agent に Start ボタンが出る

- **何ができるか**
  - まだ CLI を起動していない agent を、手動で起動できます。
- **確認方法**
  1. 新しい workspace を作る
  2. まだ何も送っていない状態で accordion を開く
  3. `起動前` の agent に `Start` ボタンがあるか見る
- **OK の目安**
  - 未起動 agent にだけ Start ボタンが表示される

## 10. Start ボタンで CLI を手動起動できる

- **何ができるか**
  - チャットを送る前に、先に CLI だけ起動できます。
- **確認方法**
  1. 未起動 agent の `Start` を押す
  2. 状態が `起動中` → `稼働中` などに変わるか見る
  3. 必要なら Terminal を開いて ready 状態を確認する
- **OK の目安**
  - ボタン押下で状態が変わり、以後 prompt を送れる

## 11. Terminal を開いただけでは CLI が起動しない

- **何ができるか**
  - Terminal 表示そのものは「見るだけ」で、重い CLI 起動はしません。
- **確認方法**
  1. まだ Start していない agent の Terminal を開く
  2. 何も送らず、そのまま表示を見る
  3. sidebar の状態が `起動前` のままか確認する
- **OK の目安**
  - Terminal は黒画面のままで、勝手に起動しない

## 12. Chat の bare prompt は親 agent に送られる

- **何ができるか**
  - 普通に prompt を送ると、その workspace の親 agent が受け取ります。
- **確認方法**
  1. 親 agent がある workspace を開く
  2. Chat に `Say only: OK-PARENT-01` のような短い prompt を送る
  3. どの agent の返答として扱われたか確認する
- **OK の目安**
  - 親 agent からの返答として保存・表示される

## 13. `agentName? prompt` で child agent に送れる

- **何ができるか**
  - 子 agent を明示して、その agent だけに仕事を振れます。
- **確認方法**
  1. child agent を持つ workspace を使う
  2. Chat に `childAgent名? Say only: OK-CHILD-01` を送る
  3. child agent 宛てとして処理されたか確認する
- **OK の目安**
  - 親 agent ではなく、指定した child agent の返答になる

## 14. Chat 送信で未起動 CLI が自動起動する

- **何ができるか**
  - Start を押していなくても、Chat 送信時に必要な CLI を起動してから処理します。
- **確認方法**
  1. `起動前` の agent を選ぶ
  2. Chat から prompt を送る
  3. 状態が `起動前` から変わって返答まで進むか見る
- **OK の目安**
  - 送信だけで CLI が立ち上がり、そのまま返答が返る

## 15. Terminal の補助入力欄から送っても未起動 CLI が起動する

- **何ができるか**
  - Terminal 下の補助入力欄から送っても、同じように必要な CLI を起動できます。
- **確認方法**
  1. `起動前` の agent の Terminal を開く
  2. 補助入力欄から短い prompt を送る
  3. 状態変化と返答を確認する
- **OK の目安**
  - Start を押さなくても、補助入力送信から起動して返答する

## 16. Chat と Terminal は同じ PTY を共有する

- **何ができるか**
  - Chat から送った内容の流れが、同じ agent の Terminal にも出ます。逆に Terminal 側の同じセッションも継続します。
- **確認方法**
  1. Chat から prompt を送る
  2. 同じ agent の Terminal を開く
  3. 同じ会話の流れが見えるか確認する
  4. 2 回目の prompt を送って会話が続くか確認する
- **OK の目安**
  - 別セッションにならず、同じ会話の続きとして動く

## 17. Terminal で reconnect / kill が使える

- **何ができるか**
  - 接続だけ張り直したり、該当 agent の PTY を止めたりできます。
- **確認方法**
  1. 何らかの agent を起動済みにする
  2. Terminal の `reconnect` を試す
  3. 必要なら `kill` を試す
  4. 状態が変わるか確認する
- **OK の目安**
  - reconnect で再接続でき、kill で停止状態に戻る

## 18. Chat には途中経過が少しずつ出る

- **何ができるか**
  - 長い返答の時、最後に一気に出すだけでなく、途中の文章も段階的に見せます。
- **確認方法**
  1. 少し長めの prompt を送る
  2. 返答が途中から伸びていくか確認する
  3. 完了前にも部分的に読めるか見る
- **OK の目安**
  - 完了前でも、返答の一部が見える

## 19. working 表示が更新される

- **何ができるか**
  - 「今 AI が考え中・実行中か」が画面上で分かります。
- **確認方法**
  1. 少し時間がかかる prompt を送る
  2. working 表示や running 状態が出るか確認する
  3. 完了後に消えるか、完了表示に変わるか確認する
- **OK の目安**
  - 実行中は working が見え、終わると完了状態になる

## 20. assistant の返答は履歴に保存される

- **何ができるか**
  - ページを再読み込みしても、その workspace の会話履歴を見直せます。
- **確認方法**
  1. 何回か Chat を送受信する
  2. ページをリロードする
  3. 同じ workspace を開き直す
- **OK の目安**
  - 過去の user / assistant メッセージが残っている

## 21. 返答本文は「プロンプト後の本文」を優先して保存する

- **何ができるか**
  - 余計なシステム行より、ユーザーが送った prompt の後に出た本体テキストを保存しやすくしています。
- **確認方法**
  1. 短い `Say only:` prompt を送る
  2. Chat 履歴の assistant 本文を見る
  3. 明らかな前置きや別ターンの古い文が混ざっていないか確認する
- **OK の目安**
  - 保存本文が「今回の返答本文」に近い

## 22. custom agent を追加できる

- **何ができるか**
  - 既定の agent だけでなく、自分用の agent を UI から足せます。
- **確認方法**
  1. `Agents` タブを開く
  2. custom agent を新規作成する
  3. 一覧に追加されるか確認する
- **OK の目安**
  - 新しい agent が作成され、workspace に追加対象として使える

## 23. custom agent を編集できる

- **何ができるか**
  - model、workdir、instruction などをあとから変更できます。
- **確認方法**
  1. 既存の custom agent を編集する
  2. 値を変更して保存する
  3. 再度開いて反映を確認する
- **OK の目安**
  - 編集した内容が保持される

## 24. custom agent を削除できる

- **何ができるか**
  - 不要になった custom agent を一覧から消せます。
- **確認方法**
  1. custom agent を作る
  2. 削除を実行する
  3. 一覧から消えたか見る
- **OK の目安**
  - 削除後、その agent が選択肢から消える

## 25. workspace と Discord channel を 1:1 で紐づけできる

- **何ができるか**
  - 特定の Discord channel を、特定の workspace に結びつけられます。
- **確認方法**
  1. Discord 設定が有効な状態にする
  2. UI の workspace settings から channel binding を設定する
  3. 保存後に設定が残るか確認する
- **OK の目安**
  - その workspace に Discord channel が紐づく

## 26. 未紐づけの Discord channel では plain message で自動作成しない

- **何ができるか**
  - 誤爆防止のため、何も紐づいていない channel で普通の文章を送っても勝手に workspace を作りません。
- **確認方法**
  1. 未紐づけ channel を使う
  2. plain message を送る
  3. 案内メッセージになるか確認する
- **OK の目安**
  - workspace は増えず、案内だけ返る

## 27. Discord の `new!` で workspace を作れる

- **何ができるか**
  - Discord 側から新しい workspace を作れます。
- **確認方法**
  1. 未紐づけ channel で `new!` を送る
  2. workspace が作成されるか確認する
  3. UI 側にも増えているか見る
- **OK の目安**
  - 新規 workspace が作成され、その channel と結びつく

## 28. Discord の `workspace! <名前>` で既存 workspace に紐づけできる

- **何ができるか**
  - Discord channel を、既存の workspace に後からつなげられます。
- **確認方法**
  1. UI で workspace を 1 つ作っておく
  2. Discord channel で `workspace! その名前` を送る
  3. binding が切り替わるか確認する
- **OK の目安**
  - 指定 workspace に紐づく

## 29. Discord の plain prompt は親 agent に送られる

- **何ができるか**
  - 紐づけ済み channel では、普通に文章を送るだけで親 agent に仕事を頼めます。
- **確認方法**
  1. binding 済み channel を使う
  2. plain prompt を送る
  3. UI の Chat / Terminal でも同じ流れが見えるか確認する
- **OK の目安**
  - Discord からの prompt が parent agent に届く

## 30. Discord の `agentName? prompt` で特定 agent に送れる

- **何ができるか**
  - Discord からも child agent を明示指定できます。
- **確認方法**
  1. child agent を含む workspace を channel に紐づける
  2. `agentName? Say only: OK-DISCORD-AGENT` を送る
  3. 指定 agent の返答になるか確認する
- **OK の目安**
  - 明示した agent にだけ routing される

## 31. Discord 添付ファイルを prompt に含められる

- **何ができるか**
  - 画像やファイルを AI に渡して、その内容を前提に応答させられます。
- **確認方法**
  1. Discord で画像かテキストファイルを添付して送る
  2. AI が添付前提の返答をするか見る
  3. UI 側の履歴にも反映されるか確認する
- **OK の目安**
  - 添付が無視されず、会話文脈に入る

## 32. Discord の runtime コマンドで運用状態を見られる

- **何ができるか**
  - `status!`、`output!`、`enter!`、`approve!`、`deny!` などで Discord から直接運用できます。
- **確認方法**
  1. `status!`
  2. `output!`
  3. 承認待ちがあるなら `approve!` か `deny!`
  4. 既存 PTY があるなら `enter!`
- **OK の目安**
  - それぞれ対応した情報や操作結果が返る

## 33. scheduler から既存 workspace / agent を定期実行できる

- **何ができるか**
  - 決まった時間や cron 設定で、既存 agent に定期実行をかけられます。
- **確認方法**
  1. schedule を 1 件作る
  2. 対象 workspace / agent を設定する
  3. 実行タイミング後に Chat / Terminal / 履歴を確認する
- **OK の目安**
  - scheduler からの実行が同じ shared PTY に流れる

## 34. Durability / resume でセッション復帰の材料を残せる

- **何ができるか**
  - 前回の run 状態、resume 情報、監査情報を残し、再開しやすくします。
- **確認方法**
  1. workspace settings の durability / resume を開く
  2. 何か 1 回実行する
  3. 画面に last run や binding 情報が出るか確認する
- **OK の目安**
  - 実行後に resume / audit 系の情報が見える

## 35. Checkpoint を作れる

- **何ができるか**
  - 今の作業状態を「戻りポイント」として保存できます。
- **確認方法**
  1. workspace settings で checkpoint 作成を実行する
  2. 一覧に新しい checkpoint が増えるか確認する
- **OK の目安**
  - 作成した checkpoint が表示される

## 36. Rollback preview で戻る前の差分を見られる

- **何ができるか**
  - いきなり戻さず、「戻したらどうなるか」を先に確認できます。
- **確認方法**
  1. checkpoint を 1 つ選ぶ
  2. rollback preview を実行する
  3. 差分や影響範囲が見えるか確認する
- **OK の目安**
  - apply 前に preview 情報が出る

## 37. Rollback apply で checkpoint に戻せる

- **何ができるか**
  - 必要なら、checkpoint 時点に戻す操作ができます。
- **確認方法**
  1. 小さい変更を加えた状態を作る
  2. checkpoint を選んで rollback apply を実行する
  3. 元の状態に戻るか確認する
- **OK の目安**
  - preview どおりに戻る

## 38. Task coordination で claim / release / handoff ができる

- **何ができるか**
  - 「今この作業は誰が担当か」を管理できます。
- **確認方法**
  1. workspace settings の task coordination を開く
  2. claim を実行する
  3. 必要なら handoff や release も試す
- **OK の目安**
  - owner や queue の表示が変わる

## 39. Workspace profile を prompt 前置きに反映できる

- **何ができるか**
  - この workspace の性格を「保守的」「積極的」などの方針として AI に渡せます。
- **確認方法**
  1. mode / persona / autonomy / notes を設定する
  2. そのあと prompt を送る
  3. 挙動が profile 反映後らしいか確認する
- **OK の目安**
  - 設定値が保存され、次の実行に反映される

## 40. Review / isolation で変更確認ができる

- **何ができるか**
  - その workspace の変更差分や分離状態を確認できます。
- **確認方法**
  1. 対象 workdir でファイル変更を 1 つ作る
  2. workspace settings の review / isolation を開く
  3. 差分検出が出るか確認する
- **OK の目安**
  - tracked change や review 情報が見える

## 41. Isolated worktree を作れる

- **何ができるか**
  - 本体作業フォルダと分けた「隔離された作業フォルダ」を作れます。
- **確認方法**
  1. workspace settings から isolated worktree 作成を実行する
  2. 作成後の状態表示を見る
- **OK の目安**
  - isolated 状態として認識される

## 42. Semantic lock で競合しそうな作業を管理できる

- **何ができるか**
  - 同じ対象を複数 agent が同時に触るのを抑えるためのロック管理です。
- **確認方法**
  1. lock claim を実行する
  2. 同じ対象で別 agent から claim を試す
  3. 競合表示が出るか確認する
- **OK の目安**
  - 先着 lock が保持され、後続は競合扱いになる

## 43. Workspace memory を手動保存できる

- **何ができるか**
  - その workspace 固有のメモを残し、次の prompt の前提にできます。
- **確認方法**
  1. workspace memory に短い文章を保存する
  2. 再度 settings を開いて残っているか見る
  3. その後 prompt を送って前提反映を確認する
- **OK の目安**
  - memory が保持され、必要時に参照される

## 44. Memory automation で preview / apply ができる

- **何ができるか**
  - consolidation / diary / dreaming のような自動整理を preview してから適用できます。
- **確認方法**
  1. memory automation の preview を開く
  2. 内容が出るか確認する
  3. apply を実行して保存結果を見る
- **OK の目安**
  - preview と apply の両方が動く

## 45. Dashboard / Task board / Workflow validation / Drift が見られる

- **何ができるか**
  - 今の workspace の運用状況をまとめて見る管理画面です。
- **確認方法**
  1. workspace settings の automation / extensions を開く
  2. dashboard、task board、validation、drift などを切り替える
  3. 各パネルが表示されるか確認する
- **OK の目安**
  - 主要パネルが空白エラーにならず表示される

## 46. Skill registry を見て workspace に同期できる

- **何ができるか**
  - 利用可能な skill の一覧を見て、その workspace 用に同期できます。
- **確認方法**
  1. skill registry 表示を開く
  2. skill sync を実行する
  3. plan や結果が返るか確認する
- **OK の目安**
  - skill の一覧確認と sync 実行ができる

## 47. MCP registry を見て workspace に同期できる

- **何ができるか**
  - MCP 接続設定の候補を見て、その workspace に反映できます。
- **確認方法**
  1. MCP registry を開く
  2. MCP sync を実行する
  3. plan や結果を確認する
- **OK の目安**
  - MCP 一覧取得と sync 実行ができる

## 48. Chat 内の URL / Windows path / file URI を開ける

- **何ができるか**
  - 会話に出てきたリンクやファイルパスを、そのまま確認しやすくしています。
- **確認方法**
  1. Chat に URL か `C:\...` 形式のパス、または `file:///...` を含むメッセージを出す
  2. クリックできるか確認する
  3. file viewer が開くか確認する
- **OK の目安**
  - リンクとして開けるか、内容プレビューが出る

---

## 確認のおすすめ順

1. まずは **1〜21** のローカル UI / PTY 基本機能
2. 次に **22〜24** の custom agent
3. Discord を使うなら **25〜32**
4. 自動化と運用機能は **33〜47**
5. 便利機能として最後に **48**

## 進め方のおすすめ

1. 1 項目確認したら、結果を「OK / NG / 保留」で別メモに残す
2. NG の時は「どの番号で、どこまで進んだか」を一緒に残す
3. Discord や Git が必要な項目は、前提が未設定なら「未確認」にして後回しでよい

