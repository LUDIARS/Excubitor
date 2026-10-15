---
task: "Ergo package update delivery job (Ergo W5, Excubitor side)"
project: Ex
kind: task
created: 2026-10-15
memory_links: []
actio: "actio:92d6f58d-0406-4a4c-9af5-759b687b93e3"
---

neco 指示: Ergo パッケージマネージャの W5 のうち Excubitor 側 (更新の出来事を Discord へ配送するジョブ) を実装する。
設計の正本は Ergo の spec/feature/package-manager.md §3・§4・§5.2 末尾・§7 W5。Ergo のファイルは変更しない。

仕様: spec/feature/ergo-watch-delivery.md (SPEC-ERGO-WATCH-DELIVERY)。

範囲:

- update ドメインに package-update-audit と同じ形のジョブを 1 本 (`src/update/ergo-watch/`)。catalog で `ergo_watch` の
  checkout を `--host` に並べて `ergo_pkg watch` を起動し、events.json を整形して Discord へ。1 出来事 1 件 + 日次要約 1 本、
  秘匿の伏せ字、2,000 字の分割、非公開ホストは別 webhook、出来事 0 件は「新規なし」、15 分ごと。
- webhook は暗号化 config にだけ置く。
- テスト: 見本から本文を作り秘匿が無い、0 件で「新規なし」、分割。

範囲外 (人間の判断): ジョブの登録、Excubitor の再起動、実際の Discord 送信、webhook の設定。

受入条件 (augur.contracts.json):

- C-14 formatEventMessage(event): 出来事 1 件の本文に URL・絶対パス・資格情報の代入・長い 16 進が無く、各メッセージが 1,900 字以下
- C-15 formatRunText(eventCount, messages): 出来事 0 件の回は「新規なし」を返す
- C-16 packDiscordMessages(blocks): どのメッセージも上限以下で、空白を除いた内容を落とさない
- C-17 routeEvents(events, privacy): 非公開ホスト・非公開依存・対応付かないホストの出来事を public に入れない
- C-18 buildWatchArgs(input): Revisor / Concordia は loopback の URL だけを渡し、全てのホストを --host に並べる

catalog の Ludellus-Native への `ergo_watch: true` は Ludellus-Native リポ所有の `excubitor.catalog.yaml` の変更になる
(中央 catalog は無い)。この PR の範囲 (Excubitor の worktree) の外なので、反映手順として PR に書く。

## 再利用の採否

- 採用: `package-update-audit` のジョブの形 (CLI + Task Scheduler + 日付ログ)、暗号化 config store、
  `sendDiscordWebhook` (URL の許可リストとメンション無効)、`findGitRoot` (cwd を含む checkout の root)、
  `execCapture` (shell 無し・窓無し・timeout)。
- 共通化: package-update-audit の Discord 分割を `src/notify/discord-messages.ts` へ切り出して両方で使う (挙動は同じ)。
- 不採用: topology の `<CODE>_URL` (host が `localhost` や拠点の上書きになり得る。Ergo は loopback だけ受けるので
  catalog の port から `127.0.0.1` を作る)。package-audit の env webhook 上書き (webhook は暗号化 config だけに置く指示)。

## 反映手順 (人間の判断で行う。この PR では行っていない)

1. マージ後、Excubitor の本体 checkout で `npm run build`。
2. `ergo_pkg` を用意する (Ergo のビルド出力。PATH に無ければ `excubitor.config.yaml` の `ergo_watch.ergo_pkg` に
   `${ARS_ROOT}/...` で場所を書く)。
3. Ludellus-Native リポの `excubitor.catalog.yaml` のサービスに `ergo_watch: true` を足す (Ludellus-Native の PR。
   この PR の worktree の外なので未実施)。Ludellus-Native 側で `ergo_pkg init --code Ln` が済んでいること。
4. webhook を暗号化 config へ保存する (値はファイルにせず、その場で送る):
   `PUT http://127.0.0.1:<Excubitor の port>/api/v1/config/notifications/ergo-watch/discord`
   `{"webhook_url":"<公開用>","private_webhook_url":"<非公開用 (任意)>","enabled":true}`。
   `GET /api/v1/config/notifications` の `ergo_watch_discord.configured` が true になる。backend の再起動は要らない。
5. 送らずに確かめる: `npm run ergo:watch` (本文の表示だけ。状態は書かない。Ergo の前回状態は進む)。
6. 登録: `.\scripts\install-ergo-watch-task.ps1` (15 分ごと。登録だけで起動しない)。ログは `logs/ergo-watch/`。

未実施: テストの実行 (指示により実行していない。型検査 `tsc --noEmit` は通過)、ジョブの登録、Excubitor の再起動、
実際の Discord 送信、Ludellus-Native の catalog 変更。Augur の集計は実行時の証跡が無く C-14〜C-18 は uncovered。
