# ローカルサービス・プロダクトランチャー (v0.3)

Excubitor を「ローカル LUDIARS サービス群の常駐ランチャー」 に拡張する。
監視コア (死活/ログ/エラー) に加えて、 **サービスの起動制御・永続化・ログ監視・
アップデート確認/配信・新規サービス検出** を 1 つの常駐プロセス + Web GUI で行う。

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

## 6. GUI (Web、 port 17333)

- **Launcher** タブ (`frontend/src/pages/Launcher.tsx`) を新設:
  アップデート一覧 (available のみ + 「更新」 ボタン + origin 取得) と
  新規サービス検出 (候補 / clone 欠落)。
- **Monitor** タブ: Vg バッジ + 全サービスでログドロワー表示。
- 起動セット選択は従来の **Launch** タブ、 死活監視は **Monitor**、 設定は **Config**。

## 今後 (このフェーズ外)

- catalog への候補のワンクリック登録 (services.yaml 追記 or DB overlay)。
- 欠落リポの `git clone` 実行ボタン。
- アップデートの定期チェック + 通知 (Nuntius 連携)。
- Tauri 等によるネイティブ常駐シェル (現状は Node 常駐 + Web GUI)。
