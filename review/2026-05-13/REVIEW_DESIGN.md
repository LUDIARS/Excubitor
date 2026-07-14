# 設計レビュー — Excubitor v0.1

評価: **B**

## 良い点

- 責務分離が明快 (catalog / scanner / control / process / log / infisical / auto_fix が独立モジュール)。
- catalog YAML を source of truth、 DB は snapshot 保持、 file watch でホット反映 (`src/index.ts:611-619`)。
- Infisical credential はメモリのみ保持で永続化なし (`src/infisical/client.ts:23-44`)、 forget endpoint も用意 (`src/index.ts:316-319`) — spec §9.3 と一致。
- auto-fix の human escalation 経路 (`src/auto_fix/trigger.ts:34-46`, `runner.ts:101-115`) で「壊れたら止める」 設計。

## 懸念

- **D-1 (high)**: 認可境界が `x-excubitor-actor` ヘッダの自己申告のみ (`src/index.ts:274,308,426,510,587`)。 spec §9.1 「Cernere session 必須」 が未達。 17331 アクセス可能なだけで全権限。
- **D-2 (medium)**: Infisical bootstrap が plaintext HTTP 経由で client_secret 受信 (`src/index.ts:298-314`)。 TLS 要件が spec オープン課題に無い。
- **D-3 (medium)**: spec §7.2.4 のマスク要件 (Infisical 値の redacter) が実装に無い。 stdout/stderr が audit_log にそのまま流れる (`src/control/manager.ts:55-70`)。
- **D-4 (medium)**: docker-compose runtime の autostart 未実装 (`src/process/autostart.ts:26-30` で skip)。 MVP §11-⑩ の `/dev/shm` override も未実装。
- **D-5 (low)**: v0.1 同居前提なのに hosts テーブル + heartbeat 概念が空のまま。 自ホスト upsert 仕様が無い。
- **D-6 (low)**: `LUDIARS_ROOT = E:/Document/Ars` と catalog の `compose_file` 30+ 箇所が Windows 絶対パス。 中央サーバ移植時の負債。

## 結論

v0.1 scaffold としては設計と実装が概ね対応、 ドキュメント密度も高い。 ただし「中央サーバ + Cernere 連携 + Infisical 遠隔」 を謳う以上、 認可レイヤと redaction の議論抜けが v0.2 に持ち越されるリスク。 v0.1.x で D-1 / D-3 を埋める PR を提案。
