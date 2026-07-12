# Excubitor (再稼働 — 2026-05-31)

> **2026-05-31 に「サービス監視・運用コア」専用サービスとして再稼働。**
> 一度 Concordia へ吸収 (2026-05-17) したが、Concordia=AI 協調支援 / Excubitor=サービス監視
> の責務分割により、Concordia で稼働実績のあった observability 層を SQLite 化して移植し直した。
>
> - 観測層 (catalog / scanner / log / error / auto-fix) を Concordia から移植
> - lifecycle は Ex の外側にある persistent local supervisor + `excubitorctl` が所有
> - DB は **SQLite** (better-sqlite3 + drizzle-orm)。旧 Postgres + Infisical-relay は廃止
> - port: production backend + WebUI **17332** (`EXCUBITOR_PORT`) / Vite dev server **17333**。loopback only
> - 設計書: [`spec/plan/design.md`](spec/plan/design.md) (v0.2 + local-control amendment)

---

LUDIARS 全サービスの可観測性 + 集中設定 + ログ監視 UI。起動・停止・再起動の正本は
HTTP サーバーではなく、Ex の外側で動く local-control supervisor である。

| 機能 | 概要 |
|------|------|
| 死活監視 | docker / プロセスの running 状態 + health endpoint 結果 |
| ログ集約 | 各サービスの stdout/stderr を中央へストリーム |
| エラータスク | ログのエラーパターンを検知 → triage キュー + 通知 |
| 設定可視化 | compose / env / Infisical 設定を統合表示 |
| 復旧操作 | UI/API は `excubitorctl` と同じ IPC を代理実行。HTTP 停止中も CLI から操作可能 |
| 自動起動 | supervisor が catalog `autostart: true` と restart policy を所有 |
| Secret 注入 | Infisical fetch → 子プロセス env に直接渡して `.env` ファイルを残さない |
| 起動credential | GLAB等のspawn直前にExがsecret生成 → Cernereへ暗号化記録 → 子envへ注入 |
| Infisical 遠隔設定 | secret CRUD を Excubitor 1 か所から |

## ローカル制御モデル

- `npm run service` は local-control supervisor の foreground/dev 起動。常設環境では installer が
  絶対パスの Node と `dist/service-runner.js` を直接登録し、OS service manager が Node PID を所有する。
  npm / PowerShell wrapper は常設プロセスに挟まない。custom service name は検証済みの
  `--service-name=<name>` 引数で runner に渡す。
- `npm run ctl -- ...` はリポジトリ内から使う CLI。package bin を導入済みなら
  `excubitorctl ...` も同じ契約で利用できる。
- Ex backend は monitor/config/log UI であり、process lifecycle の所有者ではない。
- Web control API は supervisor の IPC へ要求を中継するだけで、独自に spawn/kill しない。
- emergency port kill / Claude port fix も同じ service target queue で実行する。

```bash
npm install
npm --prefix frontend install
npm run build
npm --prefix frontend run build

# foreground/dev supervisor (normally installed as an OS service)
npm run service

npm run ctl -- excubitor status --json
npm run ctl -- excubitor start --json
npm run ctl -- service concordia restart --json
npm run ctl -- service concordia kill-port --port=17332 --json
```

Windows の常設起動は、非昇格の `excubitorctl` と同じアカウント・Limited権限で動く
per-user scheduled task を使用する。task action は checkout の Node executable と
`dist/service-runner.js` を直接起動し、working directory も checkout root に固定する。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-service.ps1
```

同名の旧 Windows Service / NSSM サービスが残っている場合、installer は何も変更せず停止する。
per-user task と旧サービスの二重起動を避けるため、移行は管理者 PowerShell から明示的に行う。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-service.ps1 -MigrateLegacyService
```

移行は旧サービスを停止・無効化するが、サービス登録は削除しない。元の start mode と稼働状態は
`data/windows-service-migration-Excubitor.json` に保存され、新しい Scheduled Task の登録・起動に
失敗した場合は自動的に復旧する。task を削除して旧サービスへ戻す場合も明示操作とする。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-service.ps1 -RestoreLegacyService
```

通常の `scripts/uninstall-service.ps1` は per-user task だけを削除し、Windows Service / NSSM の
登録や状態を黙示的に変更しない。

`start-excubitor.bat` は backend と WebUI の依存導入・build 後に
`npm run ctl -- excubitor start --json` を実行する。
mutating CLI は IPC が無い場合、導入済みの OS service manager に supervisor の起動を要求して
endpoint readiness を待つ。CLI の子として supervisor を直接 spawn しない。未導入の場合は
`scripts/install-service.ps1` (Windows) または `scripts/install-service.sh` (Linux/macOS) で常駐化する。
Web API は supervisor を自動生成せず 503 で fail-fast する。詳しい運用と障害試験は
[`spec/plan/local-control.md`](spec/plan/local-control.md) を参照。

backend の readiness は http://localhost:17332/health で確認する。

## ラテン語の名前

**Excubitor** — ラテン語で「見張り」「警備兵」。ローマ皇宮警備隊 Excubitores の単数形。
short code: `Ex`。

## リポ構成

```
Excubitor/
├── README.md
├── package.json               # backend (Hono + Drizzle)
├── tsconfig.json
├── catalog/
│   └── services.yaml          # LUDIARS サービス定義 (source of truth)
├── migrations/                # excubitor DB スキーマ (連番 SQL)
├── spec/plan/design.md        # 設計書
├── src/                       # backend サーバ実装
│   ├── service-runner.ts      # persistent local supervisor entrypoint
│   ├── local-control/         # IPC / CLI / supervisor / state
│   └── catalog/ scanner/ control/ process/ log/ infisical/ db/
└── frontend/
    ├── config.ts              # ← サービス起動者が編集する設定 (domain 等)
    ├── vite.config.ts
    └── src/                   # React + Vite UI
```

## 起動者が編集する設定

Excubitor は LUDIARS 起動チェーンの最先頭にあり、Infisical / Cernere に問い合わせて
設定を引くこと (chicken-and-egg) ができないため、 サービス起動者が
[`frontend/config.ts`](frontend/config.ts) を直接編集する想定。

- `allowedHosts`: Cloudflare Tunnel / reverse proxy 越しのホスト名を追加
- `port`: frontend dev server port (default 17333 / 17331 は Concordia Vite が占有)
- `backendUrl`: backend (Excubitor server) の URL (default http://localhost:17332)

機密値はここに置かない (公開ドメインや port 等のみ)。

## GLABの起動credential

GLABは固定のCernere project secretを持たない。Exは`glab`をspawnするたびに32-byte secretを
生成し、Cernereの`/api/auth/project-launch-credential`へ送る。Cernereが受領値をDBへ
AES-256-GCM暗号化保存し、現行bcrypt hashへrotateした後、Exがその起動プロセスのenvへだけ
`CERNERE_PROJECT_CLIENT_ID` / `CERNERE_PROJECT_CLIENT_SECRET`を渡す。

Ex自身のissuer credentialだけは一度発行し、Cernere用Infisical projectへ
`EXCUBITOR_CERNERE_CLIENT_ID` / `EXCUBITOR_CERNERE_CLIENT_SECRET`として保存する。
