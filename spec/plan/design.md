# Excubitor 再稼働 設計書 (v0.2)

> 本書は 2026-05-31 起草。 2026-05-17 に obsolete 化し Concordia へ吸収された Excubitor を、
> **「LUDIARS サービス監視・運用コア」専用サービス** として再稼働させるための設計。
> 旧 `spec/v0.1-design.md` (Postgres + Infisical-relay 時代) の設計は破棄し、本書を正本とする。

---

## 1. 背景と目的

### 1.1 きっかけ

現状 LUDIARS のローカル開発では `E:/Document/Ars/dev.bat` → `dev.ps1` で対象サービスを選択し、
各サービスを別ウィンドウで `npm run dev` 起動している (16 サービスのトグル選択 UI)。
これは「並べて起動するだけ」で、以下が手作業 / 不在のまま:

- 起動後の死活確認 (落ちたウィンドウを目視)
- ログの集約 (ウィンドウを個別に見る)
- エラー検知・通知 (なし)
- 再起動 (ウィンドウを閉じて起動し直す)
- 一括起動順序 / 依存 (なし)

Corpus が大規模 Hub の役割を担っていくにあたり、**サービスの起動 / 再起動 / ログ集約 /
エラー検知 / 死活モニターを 1 か所に集約する運用コア**が必要、という判断。

### 1.2 責務分割の決定 (2026-05-31)

ユーザ判断により責務を明確に分離する:

| サービス | 責務 |
|---|---|
| **Concordia** | **AI 協調支援に専念** — multi-agent session の協調・記録・chat・persona・report・delegation。LLM セッションの世界。 |
| **Excubitor** (本書) | **サービス監視・運用コア** — catalog / 死活監視 / ログ集約 / エラー検知 / 起動・再起動 / 自動修正。インフラ・SRE の世界。 |
| **Corpus** | 大規模 Hub。 Excubitor にコネクタ接続し、運用情報を集約フロントに載せる。 |

→ 2026-05-17 に Concordia へ吸収した observability 層を **Concordia から抜いて Excubitor に戻す**。
ただし**ゼロからの再構築ではなく、Concordia 上で稼働実績のあるコードを移植する** (decision-metrics:
作業コスト最小・解決度同等。再実装は二重実装になり非推奨)。

---

## 2. スコープ

### 2.1 In scope (v0.2)

1. **catalog** — `catalog/services.yaml` を source of truth に全サービスを宣言 (file watch で hot reload)。
2. **scanner** — docker / プロセス / git / package version の周期スキャン → 死活 state。
3. **control** — `start` / `stop` / `restart` を API + UI から (docker-compose / node / dev-process-md)。
4. **process** — `autostart` による一括起動 (= `dev.bat` 代替)、 secret 注入、 restart_policy。
5. **log** — docker-tail / file-tail (Vestigium JSONL、 共有ログルート配下の `<code>/` を全サービス自動発見) / process-bridge を log bus に集約 + 保存。
6. **error** — error_rules でパターン検知 → error_tasks triage キュー + 通知。
7. **auto_fix** — error_task から Claude Code CLI を spawn し修正 PR まで (任意)。
8. **Web UI** — Monitor / Catalog / Errors / LogsDrawer (Concordia から移植)。
9. **Corpus コネクタ** — Excubitor が multi-hub backend を公開し、Corpus が運用情報を集約。

### 2.2 Out of scope (v0.2)

- 旧 Excubitor の **Infisical-relay** (secret CRUD を 1 か所から)。各サービス自前 fetch のまま。
- リモートホスト常駐 agent (hosts テーブルは残すが、当面 localhost 1 ホスト運用)。
- reviews (`/ludiars-review` 連携) — Concordia 側に残すか Excubitor に移すかは §7 で別途判断。
- `dev.ps1` の対話 UI 撤去 — 当面は併存させ、Excubitor 安定後に段階移行。

---

## 3. アーキテクチャ

### 3.1 全体像

```
┌───────────────────────────────────────────────┐
│ Corpus (大規模 Hub) :corpus-port               │
│   connectors/excubitor.ts ──┐                  │
└─────────────────────────────┼──────────────────┘
                              │ HTTP (multi-hub backend)
┌─────────────────────────────▼──────────────────┐
│ Excubitor backend  :17332  (loopback only)     │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐          │
│  │ catalog │ │ scanner │ │ control  │          │
│  └────┬────┘ └────┬────┘ └────┬─────┘          │
│  ┌────▼────┐ ┌────▼────┐ ┌────▼─────┐          │
│  │ process │ │  log    │ │ error    │          │
│  │ autostart│ │ bus     │ │ detector │          │
│  └────┬────┘ └────┬────┘ └────┬─────┘          │
│       │           │           │ auto_fix       │
│  ┌────▼───────────▼───────────▼─────┐          │
│  │ SQLite (better-sqlite3 + drizzle) │         │
│  └───────────────────────────────────┘         │
└─────────────────┬───────────────────────────────┘
                  │ spawn / docker compose / tail
   ┌──────────────┼──────────────┬─────────────┐
 Cernere       Actio          Corpus        ...  (catalog の各サービス)
```

### 3.2 技術スタック (Concordia 観測層と同一)

- ランタイム: Node.js >= 22, TypeScript (ESM, tsx watch で hot reload)
- HTTP: Hono + @hono/node-server
- DB: **SQLite** (better-sqlite3 + drizzle-orm)。 Concordia で SQLite 化済みの schema をそのまま流用。
- catalog: js-yaml + zod
- ログ: pino / Vestigium (`@ludiars/vestigium`) JSONL reader
- Web: React + Vite + Tailwind + Foundation UI (Concordia web から該当ページを移植)
- 起動: `npm run dev` (tsx watch、 dev-process.md 同梱)

### 3.3 ポート割当

PORT-MAP では旧 Excubitor の 17331 は Concordia web に再割当済み。**17332 / 17333 が空き**なので:

| プロセス | port | env | 備考 |
|---|---|---|---|
| Excubitor backend | **17332** | `EXCUBITOR_PORT` | loopback only |
| Excubitor web | **17333** | (vite.config) | loopback only |

→ `infra/PORT-MAP.md` を更新する (本 PR には含めず、移植実装 PR で行う)。

---

## 4. モジュール構成 (移植元 = `Concordia/src/observability/`)

そのまま移植 (パスを `src/observability/` → `src/` に戻す):

| Excubitor (新) | 移植元 (Concordia) | 内容 |
|---|---|---|
| `src/catalog/{loader,sync,watcher}.ts` | `observability/catalog/` | services.yaml ロード + DB sync + file watch |
| `src/scanner/{docker,git,host,loop,sync}.ts` | `observability/scanner/` | 周期スキャン → state / git / version |
| `src/control/{manager,docker-compose}.ts` | `observability/control/` | start / stop / restart |
| `src/process/{manager,autostart,dev-process-md,inject}.ts` | `observability/process/` | 子プロセス管理 + 一括起動 + secret 注入 |
| `src/log/{bus,docker-tail,file-tail,process-bridge,error-detector,vestigium-reader}.ts` | `observability/log/` | ログ集約 + エラー検知 |
| `src/auto_fix/{runner,investigate,seed}.ts` | `observability/auto_fix/` | 自動修正 |
| `src/db/{client,schema}.ts` | `observability/db/` | SQLite client + drizzle schema |
| `src/app.ts` | `observability/index.ts` の router 部 | Hono router |
| `web/src/pages/{Monitor,Catalog,Errors}.tsx` + `components/LogsDrawer.tsx` | `Concordia/web/src/...` | Web UI |
| `catalog/services.yaml` | `Concordia/catalog/services.yaml` | カタログ (全サービス化は §6) |

### 4.1 新規 / 改修モジュール

| モジュール | 内容 |
|---|---|
| `src/server.ts` | Excubitor 単独の bootstrap (Concordia の `bootObservability()` 相当を main 化)。 |
| `src/hub/backend.ts` | **Corpus multi-hub backend** エンドポイント (§7)。 |
| `src/notify/` | エラー通知のアダプタ。 当面は Vestigium ログ + (任意) Concordia chat / Nuntius へ webhook。 |

---

## 5. データモデル

Concordia で SQLite 化済みの schema (`observability/db/schema.ts`) をそのまま採用。 主テーブル:

| テーブル | 役割 |
|---|---|
| `hosts` | 監視ホスト (当面 localhost 1 行)。 |
| `services` | catalog snapshot (code unique + catalog_snapshot JSON)。 |
| `service_instances` | インスタンス状態 (state / pid / docker_id / git_branch / git_hash / port / package_version)。 |
| `liveness_history` | 死活プローブ履歴 (ok / latency_ms)。 |
| `service_instance_logs` | 集約ログ行 (ts / level / line)。 |
| `error_rules` | 検知ルール (pattern / pattern_type / severity / service_codes)。 |
| `error_tasks` | エラー triage キュー (state: open/ack/resolved/dismissed/snoozed + auto_fix_state)。 |
| `auto_fix_runs` | 自動修正実行ログ (branch / commit / pr_url / verify_result)。 |
| `audit_log` | 操作監査 (actor / action / target)。 |

- DB ファイル: `E:/Document/Ars/Excubitor/data/excubitor.sqlite` (gitignore)。 Concordia の DB とは分離。
- migration: Concordia の `applyMigrations()` 相当を Excubitor 用に切り出す (新規 DB なので最新 schema を 1 本にまとめてよい)。
- 注意: SQLite migration で新規カラム用 INDEX は ALTER の後に冪等発行する ([[feedback_sqlite_create_index_after_alter]])。

### 5.1 catalog Service スキーマ (zod)

Concordia の `catalog/loader.ts` の `ServiceSchema` を継承。主フィールド:

- `code` / `name` / `project_code` / `component` / `port`
- `runtime`: `docker-compose | docker | node | dev-process-md`
- `cwd` / `command` / `compose_file` / `services` / `container_names`
- `autostart` (bool) / `restart_policy` (`no|on-failure|always`) / `max_restart`
- `health` (`http|tcp|cmd` + interval / grace)
- `log_sources` / `log_path` (Vestigium JSONL を優先)
- `infisical` (project_id / environment / inject / prefix)
- `auto_fix` (enabled / branch_prefix / create_pr / pr_draft)

---

## 6. dev.bat / dev.ps1 代替

### 6.1 現状の置換対象

`dev.ps1` の 16 サービス (Cernere / Corpus / Actio / Schedula / Aedilis / Bibliotheca / Nuntius /
Concordia / Conciliator / Custos / Quaestor / Praeforma / Imperativus / Signum / Ludellus / VantanHub)
を catalog に `runtime: node` (or `docker-compose`) として全登録する。
現状 catalog は 17 entry (infra 4 + 一部サービス) なので、**不足分を追記して全サービス化**する。

### 6.2 一括起動フロー

```
Excubitor 起動
  → loadCatalog()
  → runAutostart(catalog)      # autostart:true の service を順次 spawn
      └ inject secret (process env)   # .env を残さない
      └ restart_policy に従い監視
  → scanner loop 開始 (死活)
  → log bus / error detector 開始
```

- `dev-services.json` の選択 (goal-set 等) は、catalog の `autostart` フラグ + UI トグルに移行。
- Web UI の Catalog ページから個別 `start/stop/restart`、 一括起動はトップの操作ボタン。
- **移行方針**: `dev.ps1` は当面残し、Excubitor 安定後に `dev.bat` を「Excubitor を起動するだけ」に置換。

### 6.3 起動順序 / 依存

v0.2 では catalog の記載順 + `health` の grace_period で素朴に直列化。 厳密な依存グラフ
(`depends_on`) は v0.3 以降の課題 (infra → Cernere → 各サービス、の順序保証)。

---

## 7. Corpus 連携

### 7.1 Corpus のコネクタ機構

Corpus は `ServiceConnector` 抽象で各サービスの **multi-hub backend** を HTTP で叩く
(`Corpus/DESIGN.md §4`)。Corpus 側は「サービスの backend を叩く HTTP クライアントに徹する」。

### 7.2 Excubitor 側の対応

Excubitor は multi-hub backend エンドポイント群を公開し、Corpus に `connectors/excubitor.ts` を追加:

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/hub/summary` | サービス数 / up / down / error_task 件数のサマリ (Hub カード用) |
| GET | `/api/hub/services` | サービス一覧 + state (`/api/v1/services` の hub 整形) |
| GET | `/api/hub/errors` | open な error_tasks |
| POST | `/api/hub/services/:code/control` | start/stop/restart (Corpus からの操作、要認可) |

- 認可: Corpus は接続先の認可をそのまま尊重 (Corpus は再認可しない)。Excubitor は loopback only +
  操作系 (`control`) は actor ヘッダ + audit_log 記録。
- 宣言的レンダリング: Corpus が UI を JSON 宣言で描く方針 ([[project_corpus]]) なので、
  `/api/hub/summary` は Corpus の descriptor が読みやすい flat JSON で返す。

---

## 8. API (backend :17332)

移植元 (`observability/index.ts`) の router をそのまま継承:

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/v1/services` | サービス一覧 + 最新 instance state |
| GET | `/api/v1/services/:code` | 単一サービス詳細 |
| GET | `/api/v1/services/:code/logs/recent?limit=` | 直近ログ |
| POST | `/api/v1/services/:code/control` | `{action: start\|stop\|restart}` |
| GET | `/api/v1/error-tasks?state=` | エラー triage キュー |
| PATCH | `/api/v1/error-tasks/:id` | state / note / snooze 更新 |
| POST | `/api/v1/error-tasks/:id/auto-fix` | 自動修正 trigger |
| POST | `/api/v1/error-tasks/:id/investigate` | 調査 trigger |
| GET/POST | `/api/v1/error-rules` | ルール一覧 / 追加 |
| GET | `/api/v1/auto-fix/runs?error_task_id=` | 自動修正実行履歴 |
| (§7) | `/api/hub/*` | Corpus multi-hub backend |

操作系の actor ヘッダは `x-excubitor-actor` に統一 (Concordia 移植時の `x-concordia-actor` 互換は撤去)。

---

## 9. 移植計画 (実装 PR の手順)

> 本設計書 PR とは別に、移植実装 PR を立てる ([[feedback_ai_pr_size]]: 1 PR 集約)。
> 2 リポ (Excubitor + Concordia) + Corpus を触るが [[feedback_max_5_repos_warn]] の 5 未満。

### Phase A — Excubitor に観測層を戻す

1. Concordia `src/observability/**` を Excubitor `src/**` にコピー (import パスを書き換え)。
2. `observability/index.ts` の `bootObservability()` を Excubitor `src/server.ts` の main 化。
3. `Concordia/catalog/services.yaml` を Excubitor `catalog/services.yaml` に移送 + 全サービス追記 (§6.1)。
4. Concordia web の `pages/{Monitor,Catalog,Errors}.tsx` + `LogsDrawer.tsx` を Excubitor `web/` に移植。
5. `package.json` deps を観測層が要るものに整理 (hono / better-sqlite3 / drizzle-orm / js-yaml / vestigium / zod)。
6. port 17332/17333、 DB パス、 dev-process.md、 CLAUDE.md / README の obsolete 表記を除去 + 再稼働版に更新。
7. `actor` ヘッダ等の Concordia 固有名を Excubitor へ。

### Phase B — Concordia から観測層を抜く (縮退)

1. `Concordia/src/observability/` 削除。
2. `Concordia/src/server.ts` の `bootObservability()` 呼び出し + `app.ts` の `observabilityRouter` mount 削除。
3. `Concordia/web/src/pages/{Catalog,Errors}.tsx` + ナビ項目 + `LogsDrawer` 削除 (Monitor は session 用に残すか要確認)。
4. `Concordia/catalog/services.yaml` 削除。
5. observ 専用 deps が他で未使用なら整理。
6. PORT-MAP / 各 memory (project_concordia_absorbs_excubitor, project_excubitor) を更新。

> ⚠️ Concordia は現在 3 セッションが同時に触っている可能性 ([[feedback_concurrent_session_branch]])。
> Phase B 着手前に `/v1/monitor/conflicts?repo=Concordia` で確認し、必要なら worktree 隔離。

### Phase C — Corpus コネクタ

1. Corpus `server/connectors/excubitor.ts` を追加 (§7)。
2. Excubitor `/api/hub/*` を実装。
3. Corpus の Hub カードに Excubitor サマリを表示。

### Phase D — dev.bat 移行

1. catalog 全サービス化 + autostart 検証。
2. `dev.bat` を Excubitor 起動に置換 (`dev.ps1` の対話 UI は当面残置)。

---

## 10. 決定指標による評価 (decision-metrics)

| 案 | AI 学習量 | 作業コスト | 解決度 | 主目的一致 |
|---|---|---|---|---|
| **A. Excubitor へ移植 (本書)** | 中 (2 リポ間の責務分割設計) | 中 (コピー + import 書換 + 縮退) | ◎ 5 | ◎ 5 (運用コア独立) |
| B. Concordia のまま拡張 | 低 | 小 | ○ 4 | △ 3 (AI 協調と運用が同居) |
| C. ゼロから再構築 | 中 | **大** (稼働コードを捨てる) | ○ 4 | ◎ 5 |

→ **A を採用** (ユーザ判断: Concordia=AI 支援専念 / 監視=Excubitor)。C は二重実装で作業コスト過大のため不採用。

---

## 11. 未決事項

1. **reviews** (`/ludiars-review` 連携) を Excubitor / Concordia どちらに残すか。
   - 監視・運用寄りなら Excubitor、AI セッション寄りなら Concordia。要ユーザ判断。
2. Concordia `Monitor` ページ (session 監視) と Excubitor `Monitor` (サービス監視) の名前衝突 → Excubitor 側を `Services` 等にリネーム検討。
3. error 通知の宛先 (Concordia chat / Nuntius / Discord) — v0.2 はログ + Corpus サマリのみ、通知は v0.3。
4. リモートホスト agent (hosts 複数) の再導入時期。
5. `depends_on` による起動順序保証 (§6.3) の v0.3 設計。

---

## 付録: 関連メモリ

- [[project_excubitor]] — 旧 Excubitor (obsolete)
- [[project_concordia_absorbs_excubitor]] — 2026-05-17 の吸収 (本書で逆行)
- [[project_concordia]] — AI 協調側に専念
- [[project_corpus]] — 大規模 Hub / コネクタ機構 / 宣言的レンダリング
- [[reference_ludiars_port_map]] — port 割当 (17332/17333 を使用)
- [[feedback_no_dev_server]] — dev-process.md 規約

---

## 12. v0.3 — ランチャー + Infisical relay (2026-06-04)

ユーザ指示: 「Excubitor をランチャー + 統合管理サービスとして確立。起動したら何を立ち上げるかを設定する画面を出し、決定したサービスの backend を立ち上げ Corpus / Cernere と繋げる」「環境変数を各サービス自前 Infisical fetch ではなく Excubitor からリレー。Excubitor が必要情報を Infisical から個別取得し、事前に起動チェックする」。

### 12.1 起動セット (launch profile)

- `launch_profile` singleton (id=1): `configured` / `auto_launch` / `selection (code[])`。
- **初回ウィザード + 次回自動**: 初回 (`configured=false`) は UI が起動セット選択画面 (Launch タブ) を強制表示。保存すると `configured=true`。以降の boot で `auto_launch` なら保存済み selection を自動起動 (`bootObservability` 末尾)。
- モジュール: `src/launch/profile.ts` (永続化) / `order.ts` (起動順 tier、pure) / `grouping.ts` (project 別 plan、pure) / `preflight.ts` (起動前チェック) / `orchestrator.ts` (一括 起動/停止) / `router.ts` (API)。

### 12.2 起動順序 (tier)

infra(0) → Cernere(1) → Corpus(2) → corpus 依存(VantanHub, 3) → leaf(5)。tier 単位で control を呼び、tier 間に 1.5s 待ち。Cernere / Corpus を起動セットに含めれば leaf より先に上がるので「Corpus / Cernere と繋げる」が成立 (Corpus は discovery で leaf の port + manifest を拾う)。

### 12.3 Infisical relay (各サービス自前 fetch → Excubitor 集約)

- 旧方針 (2026-05-17「各サービス自前 fetch」) を**撤回**。Excubitor が secret relay を担う (Corpus `env-bootstrap.ts` の想定経路 A)。
- `src/secrets/infisical.ts`: Excubitor 自身の machine identity (`INFISICAL_SITE_URL/CLIENT_ID/CLIENT_SECRET`) で universal-auth login → `/api/v3/secrets/raw`。token 5min / secret 60s キャッシュ。
- catalog の `infisical: { project_id, environment, inject, prefix, include, exclude }` を ServiceSchema に接続 (従来は未接続で捨てられていた)。`inject:true` のサービスは spawn 時に該当 project の secret を取得し、prefix/include/exclude を適用して子プロセス env にリレー (`process/inject.ts` の `resolveInjectEnv`)。
- **起動前チェック (preflight)**: 選択セットの各サービスで cwd / compose_file 実在 + (inject 対象なら) identity 有無 + secret 解決可否を spawn 前に検査。NG は起動から除外しレポート。`POST /api/v1/launch/preflight`、`/launch/start` は内部で preflight 実行。
- **動的project credential**: `cernere_launch_credentials`を持つserviceは、Exが実spawn直前に
  launch IDと32-byte secretを生成してCernereへ送る。Cernereがissuer grantを検査して暗号化
  永続化・現行hash rotateを完了した場合だけ、target用credentialを子envへ注入する。
  Ex自身のissuer secretは`requires_secret`で取得するが子envから必ず除外する。

### 12.4 API 追加

- `GET /api/v1/launch/plan` — profile + project 別サービス (state/startable/tier 付き)
- `PUT /api/v1/launch/profile` — 起動セット保存 (= ウィザード完了 / 設定変更)
- `POST /api/v1/launch/preflight` — 起動前チェック
- `POST /api/v1/launch/start` / `POST /api/v1/launch/stop` — 一括 起動 / 停止
- `GET /api/v1/projects` — project 別グルーピング (既存 frontend Catalog の参照先が未実装だったのを追加)

### 12.5 同梱した boot バグ修正 (fresh DB で起動できなかった)

raw INSERT が `created_at`/`updated_at`/`ts` を渡しておらず、これらが NOT NULL (default 無し) のため fresh DB では catalog sync / rule seed / scanner が全て NOT NULL 制約で落ちていた。CREATE TABLE 側に `DEFAULT (unixepoch()*1000)` を付与 + `liveness_history` テーブルが MIGRATIONS に欠落していたのを追加。node サービスは scanner が instance 行を作らないため、`updateState` で instance 行を冪等確保 (UPDATE が no-op にならないように)。

### 12.6 残課題

- leaf 各サービスの `infisical.project_id` を catalog に充填する (現状 Cernere のみ設定済。他は inject 不要扱いで自前 .env.secrets fallback)。
- Excubitor 自身の machine identity の供給経路 (`.env.secrets` / bootstrap)。
- `/api/v1/launch/start` の実走 smoke (Corpus + leaf を実際に起動して Corpus discovery が拾うか)。

---

## 13. v0.4 — 設定ファイル (Infisical identity) の暗号化保存 (2026-06-04)

ユーザ指示: 「起動時に設定ファイルを確認し Infisical 設定があれば使う、 無ければ入力を促す。 設定は salt をかけて保存」「全部 Excubitor の設定に入れておく」「config は AppData あたりに暗号化して保存し AI から普通に見れないように」。

### 13.1 設定ストア (`src/secrets/config-store.ts` + `crypto.ts`)
- 保存先: **AppData (リポジトリ外)** — `%APPDATA%/Excubitor/config.enc` (非Win は `$XDG_CONFIG_HOME` or `~/.config/Excubitor/`)。`EXCUBITOR_CONFIG_PATH` で上書き可。作業ツリーに置かないので AI/git から普通には見えない。
- **ファイル全体を salt 付き AES-256-GCM で暗号化** (scrypt 鍵導出)。siteUrl やサービスマッピングも含め平文を残さない。読めても EncryptedBlob `{v,salt,iv,tag,data}`。
- master 鍵: `EXCUBITOR_MASTER_KEY` (env) → 無ければマシン束縛値 (`hostname` + user)。鍵が変わると復号失敗 → 未設定扱いで再入力を促す。
- 中身 (復号後): `infisical` (Excubitor の machine identity: siteUrl/environment/clientId/clientSecret) + `services[code]` (各サービスの Infisical マッピング = catalog yaml の代替、こちらを優先)。「全部 Excubitor の設定に入れておく」。

### 13.2 boot フロー
- `bootObservability()` 冒頭で `applyInfisicalToEnv()`: 設定ファイルに identity があれば `process.env.INFISICAL_*` に注入 (既存 env 優先) → `secrets/infisical.ts` の relay がそのまま動く。無ければ warn ログ + UI が入力を促す。
- inject / preflight は `resolveServiceInfisical(code)` で **設定ファイル優先 → catalog フォールバック**。

### 13.3 API / UI
- `GET /api/v1/config/infisical` — identity 状態 (configured / siteUrl / clientId ヒント / 保存先パス、**平文 secret は返さない**) + サービスマッピング。
- `PUT /api/v1/config/infisical/identity` — identity 保存 (暗号化) + 即 env 反映。
- `PUT /api/v1/config/infisical/services` — サービスマッピング一括保存。
- frontend に **Config タブ**: identity 入力フォーム + サービス別 project_id マッピング編集表。

### 13.4 検証
crypto round-trip / 改竄検知 / 平文非含有の vitest 5 ケース。スモークで PUT→暗号化ファイル生成 (平文 secret 無し) + GET で状態復元を確認。

---

## 14. v0.5 — メモリ監視 + リーク検知 (2026-06-18)

ユーザ指示:「Node.js プロセスと WSL バックエンドのメモリコストが高い。メモリリークの可能性があるので、各サービスのメモリモニターを監視基盤に導入する」。死活監視 (liveness_history) と同型の時系列監視軸を Excubitor に追加する。

### 14.1 採取軸 (collector = 1 tick で全ターゲット)
`src/memory/` に分離。OS 呼び出しは tick あたり 1 回に集約し、サービス数に対して O(1) に抑える。

- **process (Tier1, 全 node/app 無改修)** — `process-sampler.ts`。`npm run dev` は shell→npm→node の木構造で spawn されるため、service_instances.pid 単体では実メモリを取りこぼす。OS から全プロセスの (pid, ppid, RSS) を 1 回取得し、instance pid を根とする**部分木の RSS を合算**する。Windows=PowerShell CIM (`Win32_Process` WorkingSetSize)、POSIX=`ps -eo pid=,ppid=,rss=`。
- **docker** — `docker-sampler.ts`。`docker stats --no-stream --format '{{json .}}'` の MemUsage を container 名 → catalog 突合でバイト化。
- **metrics (Tier2, opt-in)** — `metrics-sampler.ts`。RSS だけでは JS heap か native(external) か切り分けられない。catalog `memory.metrics_url` を設定したサービスは `process.memoryUsage()` 相当 JSON を晒し、heap/external 内訳を取得する。
- **wsl** — `wsl-sampler.ts`。WSL2 は全 distro が 1 VM を共有し Windows 側 `vmmem`/`vmmemWSL` が実メモリを抱える(=タスクマネージャの「メモリ食い」の正体)。2 軸採取: ① distro 内部 `wsl -d <d> -- cat /proc/meminfo` の `MemTotal - MemAvailable`、② Windows 側 vmmem の WorkingSet。wsl.exe の UTF-16 出力は `WSL_UTF8=1` で UTF-8 化。

### 14.2 データモデル
- `memory_samples` (append-only 時系列): `target_kind`('service'|'wsl') / `target_key`(code|distro|'vmmem') / `service_instance_id`(FK, wsl は null) / `source` / `sampled_at` / `rss_bytes` / `heap_*` / `external_*` / `array_buffers_*` / `pid` / `detail`(JSON)。複合 index `(target_kind, target_key, sampled_at)`。
- 保持期間 `retention_hours`(既定 48h) を超えた行は tick ごとに剪定。

---

## 15. v0.6 — ランチャー賢化 (ウィンドウ無し起動 / start-bat / Corpus 設定 / 横断ログ / ポート衝突 / カード) (2026-06-26)

ユーザ指示:「サービス起動時はウィンドウを作らず起動・再起動も Excubitor から」「Concordia/Memoria 等の start-xxxx.bat 系に対応」「Corpus を使う/使わないケースを設定できるように」「ログを集積しサービス毎に取得、 オンメモリで持たず全サービスをストリームで確認、 API + MCP 対応」「ポート衝突を回避・検知」「カードを大きく詳細 + 最近の更新内容」。

### 15.1 ウィンドウ無し起動 (req1)
- `process/manager.ts` の spawn を **Windows では `windowsHide: true` のみ (detached を外す)** で起動する。
  - **背景の罠**: `windowsHide` が立てる `CREATE_NO_WINDOW` は、 `detached` が立てる `DETACHED_PROCESS` と併用すると CreateProcess 仕様で**無視される** ([process-creation-flags](https://learn.microsoft.com/windows/win32/procthread/process-creation-flags))。 当初 `detached:true + windowsHide:true` を併用したため窓抑止が効かず、 コンソール非保持の `cmd.exe` が自前で新規コンソール窓を出していた (#req1 の再発)。
  - **対処**: Windows は親プロセス終了で子を連鎖終了しないため、 再起動耐性に `detached` は不要 (boot 時の pid 再採用 reconcile/adoptProcess は不変)。 `CREATE_NO_WINDOW` の子は親と別コンソールを持つので Excubitor 側 Ctrl-C の巻き添えも無い。 停止は `taskkill /T /F`、 ログは fd 直結で detached と無関係。
  - 非 Windows は setsid/プロセスグループ生存のため従来どおり `detached: true` を維持。 再起動は既存 control restart。

### 15.2 start-<service>.bat 対応 (req2)
- ServiceSchema に `start_script` (絶対パス) を追加。 runtime=node/dev-process-md で設定されていれば `command` より優先して spawn する (cwd 省略時はスクリプトの dir)。 既存 start-*.bat の「関連リポ pull → build → npm run dev」一式をそのままヘッドレス起動できる。
- catalog 配線: concordia / memoria-server / bibliotheca / quaestor / tirocinium / discutere。 `pause` は stdin=ignore で EOF 即抜け、 `env:`(BACKEND_PORT 等) は spawn env 経由で bat → npm → node が継承する。
- preflight に start_script 実在チェックを追加。

### 15.3 Corpus 利用設定 (req3)
- ServiceSchema `uses_corpus` (catalog デフォルト) + `service_prefs` テーブル (UI override、 code PK)。 解決は `launch/corpus-prefs.ts`: prefs → catalog → false。
- `PUT /api/v1/services/:code/corpus-pref` で UI から切替 (null で catalog デフォルトに戻す)。 plan / projects に実効値を載せる。
- orchestrator: 起動セットに uses_corpus=true のサービスが含まれれば Corpus を自動補完 (tier 順で先に上がる)。

### 15.4 ログ集積 横断 + MCP (req4)
- `GET /api/v1/logs` (全サービス横断 SSE、 `?codes=` で絞り) / `GET /api/v1/logs/recent` (横断の永続化済み直近、 `?codes=&limit=`)。 既存の per-service SSE / recent は維持。 オンメモリには貯めず bus → SQLite に永続化、 ライブは SSE。
- MCP サーバ `src/mcp/server.ts` (`npm run mcp`、 stdio)。 稼働中 backend を叩く薄いクライアント。 tools: list_services / service_detail / recent_logs (code or codes 横断) / ports / error_tasks。

### 15.5 ポート衝突検知 (req5)
- `scanner/ports.ts`: netstat(-ano) / ss / tasklist を解析 (parse* は pure)。 `buildPortReport` で ① catalog 重複宣言 ② LISTEN 占有 ③ 停止中サービスの port を foreign が占有 (= 起動阻害) を検出。
- `GET /api/v1/ports` + preflight に port 占有チェック (warn) 統合。 実カタログから actio/schedula の :3000 重複を検出済み。

### 15.6 カード拡大 (req6)
- Monitor を行 → 拡大カード (`component-card`) に。 state バッジ / runtime / tier / version / git branch@hash / bat・Vg バッジ / port 衝突バッジ / Corpus ON-OFF トグル / 「更新履歴」 展開で最近のコミット (`GET /api/v1/services/:code/commits` = `update/checker.ts recentCommits`)。
- `/api/v1/projects` を service_instances から git/version/last_seen で補完。 ポート衝突は上部バナーにも集約表示。

### 14.3 リーク検知 (`leak.ts`, pure)
単純な閾値超過は GC の鋸歯状(sawtooth)を誤検知するため 2 指標を併用:
1. **slope** — 観測窓 RSS の最小二乗回帰の傾き (bytes/h)。増加トレンドの強さ。
2. **monotonicRatio** — 連続差分のうち非減少の割合。鋸歯状を弾く。

`leaking` = slope ≥ 閾値 かつ monotonicRatio ≥ 0.6 かつ 最新 ≥ ベースライン×1.15。`suspect` = slope ≥ 閾値×0.5 かつ monotonicRatio ≥ 0.5。判定は collector(書込) と router(読出) が**同一の detectLeak を共有**。leaking は既存 `error_tasks` triage に起票(同一ターゲットは `[memory-leak] <key>` prefix で dedup、occurrence_count++)→ 既存の調査/自動修正フローに乗る。

### 14.4 設定 (catalog)
- per-service `memory: { enabled, metrics_url?, leak_window_min(60), leak_threshold_mb_per_hr(50) }`。
- top-level `memory_monitor: { enabled, interval_sec(60), retention_hours(48), wsl: { enabled, distros[], leak_window_min(120), leak_threshold_mb_per_hr(200) } }`。distros 空 = 自動検出(docker-desktop 系除外)。

### 14.5 API / UI
- `GET /api/v1/memory/summary` — 全ターゲットの最新値 + leak 判定 + sparkline 用ダウンサンプル系列。leaking → suspect → RSS 降順でソート。
- `GET /api/v1/memory/series?kind=&key=&window_min=&source=` — 1 ターゲットの詳細時系列。
- frontend **Memory タブ**: サービス / WSL のカードグリッド(RSS 大表示 + SVG sparkline + verdict バッジ + 傾き/単調率 + heap 内訳)。

### 14.6 検証
- pure: `units` / `process-sampler`(木合算・cycle 耐性) / `docker-sampler` / `wsl-sampler`(meminfo/distro/vmmem parse) / `leak`(flat/leaking/sawtooth/窓外除外)。
- 実 SQLite(in-memory): `store`(列往復・latestPerTarget grouping・prune・raiseLeakTask dedup)。fake-deps では拾えない実 SQL 経路を実走検証。**`error_tasks.first_seen_at/last_seen_at` は NOT NULL かつ SQL default 無し**のため INSERT で明示的に入れる(既存 error-detector の同型 INSERT は両列を省略している = 別途要確認の潜在課題)。
