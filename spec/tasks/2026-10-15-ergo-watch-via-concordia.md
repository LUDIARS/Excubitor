---
task: "Ergo package update delivery via Concordia"
project: Ex
kind: task
created: 2026-10-15
memory_links: []
actio: "actio:7d56e0c4-3bbb-4349-a54d-25d7c4e7d1fe"
---

neco 指示: Ergo パッケージ更新の配送ジョブ (`src/update/ergo-watch/`) の送り先を、Discord webhook 直送から Concordia 経由に
切り替えられるようにする。送り先はいまの AI デプロイ通知用のチャンネル (Concordia の `discord.deploy_notify_channel_id`)。

仕様: spec/feature/ergo-watch-delivery.md (SPEC-ERGO-WATCH-DELIVERY) の Delivery / Concordia。

両リポ共通の取り決め: Concordia に `POST /v1/events/package-updates` を足す (Concordia 側は別 PR)。認可は
`/v1/events/service-deployed` と同じ `x-excubitor-token`。本文は strict な
`{"source":"ergo-watch","runId":"<1〜128 字>","messages":[{"text":"<1〜1900 字>","private":<bool>}]}` (1〜20 件)。
同じ (runId, 添字) は二度投稿しない。未設定 503 `not_configured`、本文不正 400、認可なし 401、成功 202
`{"delivered":n,"failed":[...],"duplicate":bool}`。

範囲:

- `excubitor.config.yaml` の `ergo_watch.delivery: concordia | discord` (既定 concordia)。webhook 直送は `discord` として残す。
- concordia のときは service-deployed の通知と同じ Concordia の URL と token の渡し方で、整形済みの本文を送る。非公開も
  `private: true` で送る。
- 送信失敗の持ち越し・0 件で送らないこと・日次要約は今のまま。runId は実行ごとに固定し、再送でも同じ runId。
- テスト: 送り先の切り替え、本文の形、再送で runId が同じ。

範囲外 (人間の判断): Excubitor の再起動・反映、実際の Discord 送信、Concordia 側の受け口の実装。

受入条件 (augur.contracts.json):

- C-19 buildPackageUpdateBatches(runId, messages): どの束も 1〜20 件・本文 1〜1,900 字・runId 1〜128 字で、束を並べると元の本文と private を順序どおりに保つ
- C-20 queueConcordiaBatches(state, runId, messages): 前回送れなかった束を runId を変えずに先頭へ置き、0 件の回は新しい束を作らない

## 再利用の採否

- 採用: service-deployed の通知の Concordia URL / timeout (`EXCUBITOR_CONCORDIA_URL` / `EXCUBITOR_CONCORDIA_TIMEOUT_MS`) を
  `src/notify/concordia-endpoint.ts` へ切り出して両方で使う (service-deployed の挙動は同じ)。整形・伏せ字・分割・計画
  (`plan.ts`)・配送状態 (`delivery-state.ts`) は今のものをそのまま使い、送る部分だけを差し替える。
- 追加: `x-excubitor-token` は `EXCUBITOR_CONCORDIA_DISPATCH_TOKEN` が設定されているときだけ載せる。これまでの
  service-deployed の通知は token を載せておらず、loopback の Concordia が token 無しを受けることに頼っていた。未設定なら
  両方とも今と同じ。
- 不採用: catalog の `concordia` の port から URL を作る方法 (watch の `--concordia-url` 用)。指示どおり service-deployed の
  通知と同じ URL の取り方にそろえた。

## 反映手順 (人間の判断で行う。この PR では行っていない)

1. Concordia 側の `POST /v1/events/package-updates` が反映され、Concordia の設定 `discord.deploy_notify_channel_id` が
   入っていること (未設定なら 503 で各回が失敗し、束は持ち越される)。
2. マージ後、Excubitor の本体 checkout で `npm run build` (ジョブは 1 回起動なので backend の再起動は要らない)。
3. Concordia に共有 token (`excubitor_dispatch_token`) を設定している拠点は、ジョブの環境に
   `EXCUBITOR_CONCORDIA_DISPATCH_TOKEN` を同じ値で渡す。loopback の Concordia で token 未設定なら不要。
4. 登録済みの Task Scheduler はそのまま動く (`--discord` は `--deliver` の旧名として残る)。登録し直す場合は
   `.\scripts\install-ergo-watch-task.ps1`。
5. webhook 直送へ戻すときは `excubitor.config.yaml` の `ergo_watch.delivery: discord`。

未実施: テストの実行 (指示により実行していない。型検査 `tsc --noEmit` は通過)、サービスの再起動・反映、実際の Discord
送信。Augur の契約注入と集計は行っておらず C-19・C-20 は uncovered。
