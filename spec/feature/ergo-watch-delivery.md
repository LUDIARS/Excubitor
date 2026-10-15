# Ergo package update delivery {#SPEC-ERGO-WATCH-DELIVERY}

実装は `@implements SPEC-ERGO-WATCH-DELIVERY` でこの条項を参照する。

設計の正本は Ergo リポの `spec/feature/package-manager.md` (§3 検知・§4 通知・§5.2 末尾・§7 W5)、
読む形式は Ergo の `spec/data/ergo-watch-report.md` (schema 1)。Excubitor はその W5 のうち配送ジョブを持つ。
判定 (何が新しい出来事か・重複の抑止・前回状態) は Ergo の `ergo_pkg watch` が行い、Excubitor は判定しない。

## Placement and lifecycle

`package-update-audit` と同じ形の 1 回起動ジョブで、backend の監視ループには載せない。

- 実装は `src/update/ergo-watch/`、入口は `npm run ergo:watch` (表示のみ) と `npm run ergo:watch:job` (配送)。
- Windows は `scripts/install-ergo-watch-task.ps1` で Task Scheduler に 15 分ごとで登録する (登録だけで起動しない)。
  各回は `scripts/run-ergo-watch.ps1` が `logs/ergo-watch/<日付>.log` に追記する。他の OS は同じ CLI を cron から呼ぶ。
- 常駐プロセスや watcher は増やさない。

## Modules

| ファイル | 役割 |
|---|---|
| `cli.ts` | 引数と終了コード。`--deliver` (旧名 `--discord`) で配送、無ければ本文の表示だけ (状態を書かない) |
| `job.ts` | 1 回分の流れ: 対象の収集 → `ergo_pkg watch` → 読み取り → 計画 → 配送 → 配送状態 |
| `hosts.ts` | catalog の `ergo_watch` から checkout (cwd を含む git root) を集め、checkout ごとに畳む |
| `watch-args.ts` | `watch` の引数。Revisor / Concordia の URL は catalog の port から `http://127.0.0.1:<port>` |
| `runner.ts` | `ergo_pkg` を shell を通さず引数配列で起動し、診断を伏せ字にする |
| `reports.ts` | `<out>/events.json` と `<host>/.ergo/watch-report.json` の読み取り |
| `routing.ts` | 公開 / 非公開の振り分け |
| `labels.ts` / `redact.ts` | 値の表記と秘匿の伏せ字 |
| `event-format.ts` / `summary-format.ts` | 出来事 1 件の本文、日次要約、各回の表示 |
| `plan.ts` | 1 回分の配送内容 (純粋関数) |
| `concordia-batches.ts` / `concordia-deliver.ts` | Concordia へ送る束 (runId・20 件ごと) と送信 (`delivery: concordia`) |
| `deliver.ts` / `delivery-state.ts` | webhook への直送 (`delivery: discord`) と、要約日・件数・未送信の持ち越し |
| `config.ts` / `types.ts` | `excubitor.config.yaml` の `ergo_watch:` と読む形 |

Discord の 2,000 字分割は `src/notify/discord-messages.ts` を package-update-audit と共用する。

## Targets

catalog (各サービス所有の `excubitor.catalog.yaml`) の `ergo_watch`:

- `ergo_watch: true` — 公開ホスト
- `ergo_watch: { private: true }` — 非公開ホスト。webhook 直送では出来事も要約も非公開用 webhook にだけ送る。
  Concordia 経由では `private: true` を付けて送る (送り先は社内のデプロイ通知チャンネル)

サービスの `cwd` を含む git checkout の root (2 段まで、ワークスペース root は採らない) を `--host` に並べる。
同じ checkout を複数のサービスが宣言したら 1 つに畳み、1 つでも非公開なら非公開。cwd が無い・checkout で
ないサービスは対象から外して診断に出す。

## Running `ergo_pkg watch`

```text
ergo_pkg watch --host <checkout>... --state <data>/ergo-watch --out <data>/ergo-watch/out
  [--revisor-url http://127.0.0.1:<port>] [--concordia-url http://127.0.0.1:<port>]
```

- `--state` は Excubitor のデータディレクトリ (`data/ergo-watch`、`--state` で変更可)。リポの外の扱いで追跡しない。
- Revisor / Concordia の URL は catalog の `ergo_watch.revisor_service` / `concordia_service` (既定 `revisor` /
  `concordia`) の `port` から loopback で作る。ポートの数字はコードにも設定にも書かない。サービスが catalog に無い・
  port が無ければその引数を渡さない (Ergo の `sources.*` が `off`)。トークンは渡さない。
- 実行前に前回の `events.json` を消し、終了 0 のときだけ読む。失敗した回は何も配送しない。
- `ergo_pkg` の場所は `ergo_watch.ergo_pkg` (既定は PATH 上の `ergo_pkg`、`${ARS_ROOT}` 可)。

## Delivery

送り先は `excubitor.config.yaml` の `ergo_watch.delivery` で選ぶ。

- `concordia` (既定) — Concordia の `POST /v1/events/package-updates` へ送り、Concordia が Bot でデプロイ通知チャンネル
  (Concordia の設定 `discord.deploy_notify_channel_id`) へ投稿する。下の [Concordia](#concordia) を参照。
- `discord` — Excubitor の暗号化 config の webhook へ直送する (下の [Webhooks](#webhooks))。

どちらでも本文 (伏せ字・分割済み)、出来事 0 件の回に送らないこと、日次要約、送信失敗の持ち越しは同じ。

| 区分 | 何を | どこへ (webhook 直送の場合) |
|---|---|---|
| 出来事 | 1 出来事 1 件 (長ければ同じ出来事を続けて分割) | 公開ホストの公開依存 → 公開 webhook / それ以外 → 非公開 webhook |
| 日次要約 | 1 日 1 本 (`summary_hour` 以降の最初の回)。ホストごとの未解消 (`pending`) と、前回の要約以降の新しい出来事の数 | 配送先ごとに 1 本 (非公開ホストも非公開の出来事も無い日は非公開側を作らない) |

- **出来事 0 件の回は送らない** (15 分ごとに空の投稿をしない)。その回の表示 (CLI 出力・ログ) と、前回の要約
  以降に新しい出来事が無い日の要約に「新規なし」と書く。
- 公開に送るのは、`watch-report.json` のホストコードが catalog で公開と宣言された checkout に対応し、かつ依存が
  `private: false` の出来事だけ。対応付かないホストコードは非公開に倒す (fail-closed)。
- 非公開用 webhook が未設定なら非公開の出来事は送らずに数える (`withheld`)。公開へ回さない (webhook 直送のみ)。
- 送信に失敗したら、そのメッセージ以降を `excubitor-delivery.json` に順序のまま残し、次の回の最初に送る
  (watch は同じ出来事を 2 度出さないので、失敗で落とさない)。webhook 直送は `outbox`、Concordia 経由は runId ごとの束を
  `concordia_outbox` に残す。webhook 直送から Concordia へ切り替えた回は、残っていた `outbox` をその回の束の先頭へ移す。
- 本文に載せるもの: ホストのコード、依存名とコード、持ち主、種類、前後の版 (タグと SHA7)、距離、由来、local PR の番号、
  次の操作、STRICT で通るか。run id・PR のタイトル・本文・ブランチ名は載せない。
- 秘匿の伏せ字: Ergo の漏れ検査に加え、本文に入れる全ての値から URL・絶対パス (ドライブ文字・UNC・`/Users/` 等)・
  資格情報の代入・32 桁以上の 16 進を伏せる。SHA は 7 桁に縮めてから載せる。メンションは無効で送る。
- 1 メッセージは 1,900 字以下 (Discord の 2,000 字に余白)。

## Concordia {#concordia}

```text
POST <EXCUBITOR_CONCORDIA_URL>/v1/events/package-updates
x-excubitor-token: <EXCUBITOR_CONCORDIA_DISPATCH_TOKEN> (設定されているときだけ)
{"source":"ergo-watch","runId":"<1〜128 字>","messages":[{"text":"<1〜1900 字>","private":<bool>}]}  (messages は 1〜20 件)
```

- URL・timeout・token の渡し方は service-deployed の通知 (`src/deploy/deployed-dispatch.ts`) と共用
  (`src/notify/concordia-endpoint.ts`)。URL の既定は loopback の Concordia。Concordia の認可は `/v1/events/service-deployed`
  と同じ (共有 token を設定していなければ loopback の Concordia は token 無しを受ける)。
- `text` は整形済みの本文 (伏せ字・1,900 字分割済み) をそのまま、非公開ホスト・非公開依存の本文は `private: true`。
  メンションの無効化は Concordia が行う。
- `runId` は 1 回の実行ごとに 1 つ (`ergo-watch-<UTC 時刻>-<乱数 8 桁>`)。21 件以上の回は 20 件ごとの束に分け、
  `<runId>#1`、`#2` … と付ける。Concordia は同じ (runId, 添字) を二度投稿しないので、送れなかった束は **同じ runId のまま**
  次の回の最初に再送する。
- 応答の扱い:

| 応答 | 扱い |
|---|---|
| 202 `{"delivered":n,"failed":[],"duplicate":bool}` | 済み |
| 202 で `failed` が空でない | その束以降を同じ runId で持ち越す (投稿済みの添字は Concordia が飛ばす) |
| 503 `{"error":"not_configured"}`・401・5xx・通信失敗 | その束以降を順序のまま持ち越す (この回は失敗) |
| 400 (本文不正) | 再送しても通らないので捨て、診断に出して次の束へ進む |

## Webhooks

webhook は Excubitor の暗号化 config (`settings.notifications.ergoWatchDiscord`: 公開用 `webhookUrl`・非公開用
`privateWebhookUrl`・`enabled`) にだけ置く。環境変数・引数・設定ファイル・ログには置かない。API は値を返さない。

- `PUT /api/v1/config/notifications/ergo-watch/discord` — `{ webhook_url?, private_webhook_url?, enabled, clear_webhook?, clear_private_webhook? }`
- `GET /api/v1/config/notifications` の `ergo_watch_discord` — `configured` / `private_configured` / `enabled`

## CLI contract

```text
npm run ergo:watch -- [--deliver] [--json] [--config PATH] [--state DIR]
```

`--deliver` で `ergo_watch.delivery` の送り先へ配送する (`--discord` は旧名で同じ意味)。`--json` は件数・送り先・runId と
診断だけを出す (本文・webhook・token は出さない)。終了 1 は watch の失敗、配送の失敗、(`delivery: discord` で) webhook 未設定。

## Acceptance

- 出来事の見本から作った本文に URL・絶対パス・資格情報・PR のタイトル / ブランチ名が無い (見本にわざと入れる)。
- 出来事 0 件の回は Discord へ送らず「新規なし」を出し、新しい出来事の無い日の要約にも「新規なし」がある。
- 長い本文と要約が 1,900 字以下へ分割され、内容を落とさない。
- 非公開ホスト・非公開依存・対応付かないホストの出来事が公開 webhook へ行かない。
- `delivery: concordia` では webhook を使わず、整形済みの本文を `private` 付きで Concordia の受け口の形 (20 件以下の束) で送る。
  `delivery: discord` では Concordia へ送らない。
- 送れなかった束は次の回に同じ runId で再送し、出来事 0 件の回は新しい束を送らない。
