# Excubitor — サービス監視・運用コア (再稼働 2026-05-31)

LUDIARS 全サービスの **死活監視 / ログ集約 / エラー検知 / 起動・再起動 / 自動修正** を集約する
運用コアサービス。一度 Concordia へ吸収 (2026-05-17) したが、責務分割
(**Concordia=AI 協調支援 / Excubitor=サービス監視**) により再稼働。Concordia で稼働実績の
あった observability 層を SQLite 化して移植した。

設計書は [`spec/design.md`](spec/design.md) (v0.2) が正本。旧 `spec/v0.1-design.md`
(Postgres + Infisical-relay 時代) は破棄。

## 構成

| モジュール | 役割 |
|--------------|--------|
| `src/catalog/` | `catalog/services.yaml` を source of truth に読み込み + DB sync + file watch |
| `src/scanner/` | docker / プロセス / git / version の周期スキャン → 死活 state |
| `src/control/` | start / stop / restart (docker-compose / node / dev-process-md) |
| `src/process/` | autostart (一括起動) + secret 注入 + restart_policy |
| `src/log/` | docker-tail / file-tail (Vestigium JSONL) / process-bridge → log bus + error-detector |
| `src/auto_fix/` | error_task から Claude Code CLI を spawn して修正 PR まで |
| `src/server.ts` | main entry。`bootObservability()` + Hono serve |
| `frontend/` | Monitor / Catalog / Errors の Web UI (Vite + React) |

## 技術スタック

- Node.js >= 22 / TypeScript (ESM, tsx watch)
- Hono + @hono/node-server (backend **17332** / `EXCUBITOR_PORT`、loopback only)
- **SQLite** (better-sqlite3 + drizzle-orm)。DB は `data/excubitor.sqlite`
- frontend: Vite + React (**17333**)
- ログ: pino / Vestigium (`@ludiars/vestigium`)

## 起動

```bash
npm install
npm run dev        # tsx watch src/server.ts (backend)
cd frontend && npm run dev   # Vite (17333)
```

## 注意

- Infisical-relay は移植していない。secret 注入は catalog の `infisical` フィールド経由
  (各サービスが起動時に自前 fetch する設計のまま)。
- catalog の全サービス化 (dev.ps1 16 サービスの autostart 登録) と Corpus コネクタ・dev.bat 移行は
  設計書 §9 の Phase C/D で対応予定。
