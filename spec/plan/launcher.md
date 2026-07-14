# ローカルサービス・プロダクトランチャー (v0.4)

Excubitor を「ローカル LUDIARS サービス群の常駐ランチャー」 に拡張する。
監視コア (死活/ログ/エラー) に加えて、 **サービスの起動制御・永続化・ログ監視・
アップデート確認/配信・新規サービス検出** を 1 つの常駐プロセス + Web GUI で行う。

v0.4 で対象を「ローカル**サービス** (port を持つ常駐型)」だけでなく「ローカル**アプリ**
(port を持たないネイティブ/デスクトップ製品)」にも広げる (§8)。 これにより LUDIARS の
統合 2 軸 ([[project_concordia_absorbs_excubitor]] / design.md §14) を
ローカルアプリにも適用する: **Excubitor = ローカルアプリ監視 / Corpus = ローカルアプリ
集約・起動**。

## 1. 監視データの永続化と再起動耐性

> 要件: Excubitor の状態 (再起動等) にサービスが影響しないようにする。
> ログはストリームなので、 取得できないタイミングがあるのは許容する。

- 状態は `data/excubitor.sqlite` に永続化 (既存)。 boot で wipe しない。
- **子サービスは detached で spawn** する (`spawn(..., { detached: true })` + `child.unref()`)。
  Excubitor 自身が停止・再起動してもサービスは生き続ける。
- **shutdown では子を kill しない** (`bootObservability().shutdown` は監視/スキャン系のみ停止)。
  明示停止は stop API / launcher stop からのみ。
- boot 時に **reconcile** (`src/process/reconcile.ts`): DB 上 running/pending な
  node/dev-process-md インスタンスの pid を生存確認し、
  - 生存 → `adoptProcess()` で再採用 (state=running 維持、 stop 可能)
  - 死亡 → state=crashed に落として stale を解消
- ライブログ (process stdout / docker logs) は接続が無い間は欠落する (許容)。
  永続ログは `service_instance_logs`、 過去分は `/logs/recent` で取得。
- 停止は Windows ではツリーごと (`taskkill /PID <pid> /T /F`)。 detached + shell:true は
  cmd→node のツリーになるため child.kill では shell しか落ちない。

## 2. Vestigium ログ対応のマークとログ監視

- catalog の `log_path` を持つサービスは Vestigium JSONL を tail 可能 (既存 file-tail)。
- API/GUI で **`has_vestigium`** (= `log_path` 設定済み) を公開し、 Monitor にバッジ表示。
- **ライブログ SSE** `GET /api/v1/services/:code/logs` (`src/log/sse.ts`) を新設。
  log bus を購読し、 docker-tail / process-bridge / Vestigium file-tail いずれの行も配信。
  frontend `subscribeLogs` (EventSource) が購読 (従来 endpoint 不在で壊れていたのを修復)。

## 3. ローカルサービスの起動 + Tr / Di 追加

- runtime=node / dev-process-md は ProcessManager が spawn (既存、 detached 化)。
- catalog に **Tirocinium** (`npm run dev:server`, port 8084) と
  **Discutere** (`npm run dev:server`, port 3100) を追加。

## 4. アップデート確認 / 配信

- **確認** (`src/update/checker.ts`): 各サービスの git リポ (node=cwd /
  docker-compose=compose_file の親) で HEAD と origin/&lt;branch&gt; を比較し
  `behind` (取り込み可能コミット数) を算出。 `available = behind > 0`。
  - `GET /api/v1/updates?fetch=1` — 全件 (fetch=1 で origin 取得してから比較)
  - `GET /api/v1/services/:code/update` — 単一 (常に fetch)
- **配信** (`src/update/apply.ts`): `git fetch` → `git merge --ff-only origin/<branch>`
  → (node なら) `npm install` → 起動中なら restart。 dirty なリポは中断 (安全)。
  - `POST /api/v1/services/:code/update { install?, restart? }`
  - 監査は `audit_log` に `service.update` で残す。

## 5. 新規サービスの確認

- (`src/discovery/scan.ts`): Ars ワークスペース (`EXCUBITOR_ARS_ROOT`、 既定
  `E:/Document/Ars`) 直下の git リポを走査し、
  - **candidates**: catalog 未登録のリポ (runtime 推定 / dev script 有無 / remote 付き)
  - **missing**: catalog にあるが clone されていないリポ
  - `GET /api/v1/discovery`
- 登録自体は当面手動 (`catalog/services.yaml` 追記)。 候補に runtime ヒントを添える。

## 6. トポロジ env の自動注入 (URL/port)

> 要件: 環境変数のうち URL/port など Excubitor が catalog から特定可能な情報は
> Excubitor が処理して全サービスに注入する (特に Cernere URL は毎サービス必要で面倒)。

- `src/process/topology.ts`: catalog から topology env map を構築。
  1. **自動導出**: port を持つ全サービスに `<CODE>_URL` / `<CODE>_PORT`
     (CODE = code 大文字 + 非英数→`_`、 例 `MEMORIA_SERVER_URL=http://localhost:5180`)。
  2. **明示 `provides`**: catalog の各サービスが公開する正規名。 `${port}`/`${host}` 展開。
     自動導出を上書き。 例 (cernere-backend-dev):
     ```yaml
     provides:
       CERNERE_URL: http://${host}:${port}
       CERNERE_WS_URL: ws://${host}:${port}
     ```
- spawn 時に `resolveInjectEnv` が **topology + Infisical secret** をマージして注入
  (secret が同名なら secret 優先)。 これで各サービスは `CERNERE_URL` 等を自前設定不要。
- secret ではない (公開情報) ので Infisical ではなくここで扱う。
- boot / catalog reload で `setTopologyFromCatalog()` が再構築。
- 確認用 `GET /api/v1/topology`、 Launcher タブに一覧表示。
- dotenv は既存 env を上書きしないため、 Excubitor 注入値がサービスの `.env` より優先。

## 7. GUI (Web、 port 17333)

- **Launcher** タブ (`frontend/src/pages/Launcher.tsx`) を新設:
  アップデート一覧 (available のみ + 「更新」 ボタン + origin 取得) と
  新規サービス検出 (候補 / clone 欠落)。
- **Monitor** タブ: Vg バッジ + 全サービスでログドロワー表示。
- 起動セット選択は従来の **Launch** タブ、 死活監視は **Monitor**、 設定は **Config**。

## 8. ローカルアプリ (プロダクト) 対応 — runtime=app (v0.4)

> 要件: Excubitor / Corpus の統合 2 軸を、 port を持つサービスだけでなく
> **ローカルアプリ (Tauri / Electron / native exe / CLI バイナリ)** にも適用する。

ローカルアプリはサービスと**ライフサイクルが異なる** (ユーザ起動・port 無し・
クラッシュは単発・自分で終了する) ため、 専用の `runtime: app` で扱う。 dev 起動
(`npm run tauri dev` 等) は従来通り `runtime: node` で表現し、 `app` は **ビルド済の
製品 exe を起動する** ためのもの。

### 8.1 catalog スキーマ (loader.ts)

`runtime: app` のサービスに以下を追加 (いずれも任意、 `exec` のみ app で必須):

| フィールド | 役割 |
|---|---|
| `exec` | 起動する実行ファイル (絶対パス推奨)。 例 `…/target/release/hora.exe` |
| `exec_args` | exec への引数 (string[]) |
| `app_kind` | `tauri` / `electron` / `native` / `cli` (UI / Corpus 表示用の分類) |
| `build_command` | 更新適用時に git ff の後で走らせるビルド (例 `npm run tauri build`) |
| `process_match` | host スキャンで「外部起動された実体」を検知する image 名 (予約) |

health は `type: process` (= 管理下プロセスの pid 生存) を新設。 app は port が無いため
http/tcp probe は使わない。

### 8.2 起動・監視 (ProcessManager)

- `spawnService` が `app` を受理し、 `exec` (+ `exec_args`) を **detached + unref** で
  起動する (§1 と同じ再起動耐性)。 npm 解決が不要なので `shell:false` で直接起動
  (パスの空白 / backslash 対策)。 cwd 省略時は exec の dir。
- 死活は exit handler で running / crashed / stopped を反映 (port probe 不要)。
- **restart_policy 既定 `no`** を据え置く。 GUI 製品を勝手に respawn しない。
- 停止は既存の tree-kill (Windows=`taskkill /T /F`) を流用。
- boot reconcile (§1) / autostart も `app` を対象に含める。 autostart は GUI 製品の
  性質上、 catalog で `autostart: true` を明示した opt-in のみ起動する。

### 8.3 更新適用 (update/apply.ts)

git fetch + ff-only の後、 `build_command` があれば実行してから restart する。
ネイティブ製品は git pull だけでは exe に反映されないため (node の `npm install` に相当)。

### 8.4 Corpus 連携 — 集約 + 起動 (hub/router.ts)

- `/api/hub/apps` を新設: `runtime=app` の entry を `{ code, name, app_kind, state,
  launchable }` で返す (catalog 全体は `catalog_snapshot` JSON に入るため
  `json_extract(..., '$.runtime') = 'app'` で絞る)。
- corpus-service manifest の `data` に `apps` を追加し、 `actions` に **起動 / 停止**
  (既存 control `/api/v1/services/:code/control` を叩く descriptor) を宣言。 Corpus
  フロントはこの descriptor を読んでローカルアプリのカード + 起動ボタンを描画する
  (Corpus は loopback の Excubitor を connector 経由で叩く / §7)。

### 8.5 適用例

`catalog/services.yaml` に **Hora** (Tauri デスクトップアプリ) を `hora-app` として登録。
他のローカルアプリ (Quaestor / Custos / Legatus 等) も同形式で追加できる。

## 9. インタラクティブ制御 + SafeMode (v0.4)

### 9.1 サービスの対話的な起動 / 停止

Monitor タブの各サービス行に **▶ 起動 / ■ 停止 / ↻ 再起動** ボタンがあり、
`controlService(code, action)` → `/api/v1/services/:code/control` を叩く。
process 系 (node / dev-process-md / **app**) と docker 系の両方が対象
(runtime=app は §8 のローカルアプリ。 control 経路は ProcessManager spawn/kill)。

### 9.2 SafeMode — Excubitor だけ起動する

> 要件: 起動時に何もサービスを起動せず、 Excubitor 本体だけを立ち上げるモード。

- 有効化: `EXCUBITOR_SAFE_MODE=1` または起動引数 `--safe`
  (`npm run dev:safe` / `npm run start:safe`)。
- 挙動 (`src/safe-mode.ts` + `src/index.ts`): `runAutostart` と保存済み launch
  profile の auto-launch を**両方スキップ**する。 監視 / スキャン / Web GUI /
  制御 API は通常どおり動くので、 起動後に Monitor / Launch から手動で立ち上げられる。
- 公開: `GET /api/v1/system` → `{ safe_mode }`。 frontend は header に
  **SAFE MODE** バッジを出す。
- 用途: サービスが落ちて連鎖する状況の切り分け、 Excubitor 自体の更新・検証、
  クリーンな状態からの手動起動。

## 今後 (このフェーズ外)

- catalog への候補のワンクリック登録 (services.yaml 追記 or DB overlay)。
- 欠落リポの `git clone` 実行ボタン。
- アップデートの定期チェック + 通知 (Nuntius 連携)。
- host プロセススキャンによる `process_match` 実装 (外部起動アプリの自動検知)。
- **Corpus フロント側** のローカルアプリカード + 起動ボタン描画 (manifest の
  `apps` / `actions` を消費する descriptor。 Corpus 側 PR で対応)。
- Tauri 等によるネイティブ常駐シェル (現状は Node 常駐 + Web GUI)。
