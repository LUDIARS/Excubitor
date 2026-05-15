# 実装レビュー — Excubitor v0.1

評価: **B**

## 良い点

- Hono + Drizzle + Zod の LUDIARS 標準スタック準拠。 入力検証は zod schema を必ず通す (`src/index.ts:46-48, 290-294, 384-388, 408-415, 436-441`)。
- **inFlight ロック** で同一 service の auto-fix / investigate 並行実行を防止 (`src/auto_fix/runner.ts:37, 41-45`、`investigate.ts:36, 40-44`)。
- **prepare:false** で dev hot-reload + migration の plan キャッシュ問題を回避、 コメントも適切 (`src/db/client.ts:11-17`)。
- **SSE keepalive** 25 秒 ping + `c.req.raw.signal` abort listener で subscriber / interval / controller を確実に close (`src/index.ts:212-221`)。
- **exponential backoff** + max_restart 超過時の error_task 起票 (`src/process/manager.ts:139-152`)。
- **read-only 契約違反検知** は自動 revert ではなく warning 倒し (`src/auto_fix/investigate.ts:202-228`) — ユーザ WIP を壊さない explicit な選択がコメントに残る。

## 懸念

- **I-1 (high)**: `setTimeout` の auto-restart timer が shutdown 時に clear されない (`src/process/manager.ts:155-163` + `src/index.ts:636-645`)。 SIGTERM 後の再 spawn or 「already spawned」 エラー経路。
- **I-2 (medium)**: `process_logs` 永続化が fire-and-forget で backpressure 無し (`src/log/bus.ts:36-38`)。 高頻度ログで Postgres pool max=10 が枯渇。
- **I-3 (medium)**: `splitCommand` の quote / escape 未対応 (`src/process/manager.ts:195-198`)。 catalog の sensible 命令前提のコメントあり。
- **I-4 (medium)**: Reviews router の `existsSync` / `readdirSync` / `statSync` 同期 I/O が 28 リポ走査で詰まる可能性 (`src/reviews/router.ts:50-74`)。
- **I-5 (medium)**: `resolveBashPath` が module load 時の 1 回評価で焼き付き (`src/auto_fix/config.ts:11-49`)。 Git for Windows 後 install で再起動まで反映されない。 fallback path の `existsSync` warn を起動時に出すと親切。
- **I-6 (low)**: `audit_log` の target_id 命名が control/secret/bootstrap で不揃い (`src/index.ts:309-312, 428-431`、`src/control/manager.ts:59`)。 横断検索が payload join 必須。
- **I-7 (low)**: `setCatalogProvider` の `catalogProvider` 変数が `onLine` 内で参照されていない dead code (`src/log/error-detector.ts:36-39`)。
- **I-8 (low)**: `let currentCatalog` の reload 中 race (`src/index.ts:30, 614`)。 services 変動が少ないので実害は限定的。

## 結論

v0.1 scaffold としては丁寧で設計と一致。 I-1 (shutdown timer) と I-2 (log backpressure) を v0.1.x 候補に。
