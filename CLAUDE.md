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
| `src/release/` | リリースマニフェスト (`releases/*.yaml`) から自己完結ランナブル配布物を焼く (build→assemble→launcher→archive)。 spec/release.md / `npm run release` |
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

## tier (ローカルアプリ / SaaS の挙動分離)

catalog の各サービスは `tier` でデプロイ/挙動クラスを分ける (SaaS ランチャーから着手):

| tier | 対象 | 扱い |
|------|------|------|
| `saas` | デプロイするバックエンド Web サービス | SaaS ランチャーの既定対象 |
| `infra` | LUDIARS 共有インフラ (infra/ の DB / queue 等) | SaaS の依存として起動 |
| `personal` | 本人 PC 専用ツール (Memoria local / Concordia / Conciliator / Quaestor / Custos) | SaaS ランチャー対象外 |
| `local-app` | ネイティブ/デスクトップ製品 (runtime=app) | 別系統 (ローカルランチャー) |

- 解決は `serviceTier()` (catalog 明示 → 無ければ runtime 推定、 既定 saas)。
- ランチャー plan は `GET /api/v1/launch/plan?tier=saas,infra` で絞り込む。
- **フロントエンドは catalog から除外** (フロント統合=Corpus)。 backend 単独になった論理サービスは
  管理名から役割サフィックス (`-backend` 等) を外し純粋名にする (cernere / actio)。
- サービス固有の静的 env は catalog の `env:` で注入 (例 discutere `BACKEND_PORT: "3110"` で
  Nuntius(3100) との port 競合を回避)。 優先順位: topology < `env:` < secret。
- runtime=app は port を持たないため、 `process_match` (image 名) で host プロセススキャンし
  「Excubitor 外から起動した実体」 の生存も死活に反映する (scanner/host-process.ts)。

## 注意

- Infisical-relay は移植していない。secret 注入は catalog の `infisical` フィールド経由
  (各サービスが起動時に自前 fetch する設計のまま)。 `infisical.project_id` は実 ID が必要で
  捏造不可 — 現状 Cernere のみ実 ID。 他 SaaS は Infisical 側の project_id 入手後に充填する。
- detached 子の stdout/stderr は pipe ではなく **ファイル fd** に向ける (`data/process-logs/<code>.{out,err}.log`)。
  親 (Excubitor) が落ちても子が EPIPE で死なない。 ライブログ/エラー検知は process-file が tail して bus へ。
- catalog の全サービス化 (dev.ps1 16 サービスの autostart 登録) と Corpus コネクタ・dev.bat 移行は
  設計書 §9 の Phase C/D で対応予定。 ローカルアプリ (local-app) の catalog 追加 (#90) は exec
  パスを各リポのビルド出力で実在確認してから (hora-app 以外は follow-up)。
