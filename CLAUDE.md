# Excubitor — サービス監視・設定・ログ UI + local-control client

LUDIARS 全サービスの **死活監視 / ログ集約 / 設定編集 / エラー検知 / 自動修正** を集約する
運用 UI。起動・停止・再起動は Ex backend ではなく persistent local supervisor が所有する。
一度 Concordia へ吸収 (2026-05-17) したが、責務分割
(**Concordia=AI 協調支援 / Excubitor=サービス監視**) により再稼働。Concordia で稼働実績の
あった observability 層を SQLite 化して移植した。

設計書は [`spec/plan/design.md`](spec/plan/design.md) が正本。旧
[`spec/plan/v0.1-design.md`](spec/plan/v0.1-design.md)
(Postgres + Infisical-relay 時代) は破棄。

## 構成

| モジュール | 役割 |
|--------------|--------|
| `src/catalog/` | catalog を読み込み + DB sync + file watch。 3 ソースをマージ: `catalog/services.yaml` (手書き正本) > 各リポの断片 `${ARS_ROOT}/<repo>/excubitor.catalog.yaml` (`fragments.ts`、 private 定義の流出回避) > `services.auto.yaml` (scan)。 断片集積は mtime キャッシュ。 詳細 [`catalog/FRAGMENTS.md`](catalog/FRAGMENTS.md) |
| `src/scanner/` | docker / プロセス / git / version の周期スキャン → 死活 state |
| `src/local-control/` | versioned IPC、persistent supervisor、`excubitorctl` client、状態永続化 |
| `src/control/` | supervisor が利用する service adapter。HTTP route は local-control IPC の proxy |
| `src/process/` | supervisor 配下の spawn/stop/reconcile primitives。backend から直接所有しない |
| `src/log/` | docker-tail / file-tail (Vestigium JSONL, 共有ルート `logs-root.ts` 配下の `<code>/` を全サービス自動発見) / process-bridge → log bus + error-detector + SSE (`/logs` 単一/横断, `/logs/recent`) |
| `src/scanner/ports.ts` | ポート衝突検知 (netstat/ss/tasklist 解析 → 重複宣言 / LISTEN 占有 / foreign 衝突)。 `/api/v1/ports` |
| `src/memory/` | メモリ + **CPU** 監視。 プロセスツリー RSS / docker stats / WSL / **マシン全体 (host)** を周期サンプリング → 時系列 + leak 検知。 CPU% は累積 tick の tick 間 delta から算出 (`cpu-rate.ts`)。 `/api/v1/memory/summary` (services/wsl/host) |
| `src/update/` | git pull (更新適用) + アップデート/ブランチ状況確認 (`/api/v1/services/:code/update`・`/branches`・`/api/v1/updates`) |
| `src/federation/` | **他拠点 Excubitor 連携**。 remote_peers (base_url + agent token) を保持し、 local + 全ピアのサービス/host を集約 (`/api/v1/federation/services`) + リモート操作プロキシ。 公開面 (`/api/v1/federation/node\|control\|update`) は agent token 認証 |
| `src/mcp/` | MCP サーバ (stdio, `npm run mcp`)。 稼働中 backend を叩きログ/死活/ポート/メモリCPU を公開 + 制御 (control/update/branch/federation) |
| `src/auto_fix/` | error_task から Claude Code CLI を spawn して修正 PR まで |
| `src/release/` | リリースマニフェスト (`releases/*.yaml`) から自己完結ランナブル配布物を焼く (build→assemble→launcher→archive)。 spec/release.md / `npm run release` |
| `src/service-runner.ts` | local-control supervisor entrypoint |
| `src/server.ts` | monitor/config/log backend entrypoint。`bootObservability()` + Hono serve |
| `frontend/` | Monitor / Catalog / Errors の Web UI (Vite + React) |

## 技術スタック

- Node.js >= 22 / TypeScript (ESM, tsx watch)
- Hono + @hono/node-server (backend **17332** / `EXCUBITOR_PORT`、loopback only)
- **SQLite** (better-sqlite3 + drizzle-orm)。DB は `data/excubitor.sqlite`
- frontend: React。production WebUI は backend **17332** から配信し、Vite dev server のみ **17333**
- ログ: pino / Vestigium (`@ludiars/vestigium`)

## 起動と制御

```bash
npm install
npm --prefix frontend install
npm run build
npm --prefix frontend run build
npm run service    # persistent supervisor の foreground/dev 起動

# 別ターミナル。package bin 導入済みなら excubitorctl でも同じ
npm run ctl -- excubitor status --json
npm run ctl -- excubitor restart --json
npm run ctl -- service concordia restart --json
npm run ctl -- service concordia kill-port --port=17332 --json
```

- `start-excubitor.bat` は build 後に `npm run ctl -- excubitor start --json` を実行する。
- mutating CLI は supervisor 不在時に導入済みの OS service manager へ起動を要求する。
  CLI の子として supervisor を直接 spawn しない。Web API は起動を試みず 503 で fail-fast し、
  backend 内 process manager へ silent fallback してはならない。常用 supervisor は OS service が所有する。
- OS service definition は絶対パスの Node + `dist/service-runner.js` を直接 main process として起動する。
  npm / PowerShell wrapper を挟まず、custom service name は検証済みの `--service-name=<name>` で渡す。
- Windows installer は `excubitorctl` と同じアカウント・Limited権限の scheduled task を作る。
  Integrity Level が通常CLIと異なるWindows Service/NSSMはlocal-control ownerとしてサポートしない。
  named pipe は account + `EXCUBITOR_SERVICE_NAME` ごとに分離する。
- 同名の旧 Windows Service/NSSM を検出した installer は既定で fail-fast し、停止・削除・task 上書きを
  行わない。移行は elevated PowerShell の `scripts/install-service.ps1 -MigrateLegacyService` に限り、
  旧登録を保持したまま停止・無効化する。task 起動失敗時は旧 start mode/state を復旧する。
- `scripts/uninstall-service.ps1` は既定で scheduled task だけを削除する。旧 Windows Service を戻す操作は
  migration record を使う明示的な `-RestoreLegacyService` とし、NSSM service を黙示的に remove しない。
- Web control API は local tool proxy。UI の制御エラーには同等の `npm run ctl -- ...`
  fallback command を表示する。
- emergency (`kill-port` / `claude-port-fix`) も local supervisor の service queue を通す。
- JSON mode は stdout に protocol response だけを出し、診断は stderr に出す。

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
- 子の stdout/stderr は pipe ではなく **ファイル fd** に向ける (`data/process-logs/<code>.{out,err}.log`)。
  backend が落ちても子が EPIPE で死なない。ライブログ/エラー検知は backend 復旧後に tail へ再接続する。
- 起動はすべて `windowsHide: true` でコンソール窓を出さない。 既存 start-<service>.bat (pull/build/dev 一式) は
  catalog の `start_script` に絶対パスを置けば `command` より優先してヘッドレス起動する。
- `uses_corpus` (catalog) は UI から `service_prefs` (DB) で上書きできる。 起動セットに含めると Corpus を自動補完。
- **他拠点連携 (federation)**: ピアの認証は各ノードの agent token (secret-agent と共用、
  `EXCUBITOR_AGENT_TOKEN` or token ファイル) を Bearer で交換する。 ローカル DB (remote_peers) に
  相手の base_url + token を平文保存するため DB ファイル自体を機密扱いにする。 公開面
  (`/api/v1/federation/*` の node/control/update) のみ token 認証、 ピア管理 (CRUD) は loopback 依存。
  拠点名は `EXCUBITOR_NODE_NAME` (既定 hostname)。 拠点間通信は Tailscale 等のプライベート網を前提。
- catalog の全サービス化 (dev.ps1 16 サービスの autostart 登録) と Corpus コネクタ・dev.bat 移行は
  設計書 §9 の Phase C/D で対応予定。 ローカルアプリ (local-app) の catalog 追加 (#90) は exec
  パスを各リポのビルド出力で実在確認してから (hora-app 以外は follow-up)。
