# Excubitor (obsolete — 2026-05-17)

> **このリポジトリは 2026-05-17 をもって obsolete です.** 機能はすべて
> [LUDIARS/Concordia](https://github.com/LUDIARS/Concordia) に集約されました.
>
> - catalog / scanner / control / process manager / log bus / error detector / auto-fix / reviews →
>   `Concordia/src/observability/` 配下に移管
> - Infisical-relay は持ち越さず、 各サービスが自前で Infisical fetch する設計に変更
> - 旧 port (17331 / 17332) は空きに. Concordia は引き続き 17330 (backend) / 17333 (web)
>
> 詳細は Concordia 側の `CLAUDE.md` (本リポ) または auto-memory
> `project_concordia_absorbs_excubitor` を参照してください.
>
> 過去の `review/` データはアーカイブ目的でこのリポに残置しています.

---

LUDIARS 全サービスの可観測性 + 復旧操作 + 集中設定の中央サーバ。

| 機能 | 概要 |
|------|------|
| 死活監視 | docker / プロセスの running 状態 + health endpoint 結果 |
| ログ集約 | 各サービスの stdout/stderr を中央へストリーム |
| エラータスク | ログのエラーパターンを検知 → triage キュー + 通知 |
| 設定可視化 | compose / env / Infisical 設定を統合表示 |
| 復旧操作 | ダウン中のサービスを UI から start / restart |
| 自動起動 | catalog `autostart: true` を起動時に自動 spawn (dev-process.md 互換) |
| Secret 注入 | Infisical fetch → 子プロセス env に直接渡して `.env` ファイルを残さない |
| Infisical 遠隔設定 | secret CRUD を Excubitor 1 か所から |

設計書: [`spec/v0.1-design.md`](spec/v0.1-design.md)

## クイックスタート (v0.1 dev)

LUDIARS infra (postgres + redis) が起動している前提。

```bash
# 1. infra に excubitor DB を作成 (1 回だけ)
cd ../infra
docker compose exec -T postgres psql -U ludiars -c "CREATE DATABASE excubitor;"
docker compose exec -T postgres psql -U ludiars -c "CREATE USER excubitor_user WITH PASSWORD 'excubitor';"
docker compose exec -T postgres psql -U ludiars -c "GRANT ALL PRIVILEGES ON DATABASE excubitor TO excubitor_user;"
docker compose exec -T postgres psql -U ludiars -d excubitor -c "GRANT ALL ON SCHEMA public TO excubitor_user;"

# 2. excubitor migration を適用
node migrate.mjs excubitor

# 3. Excubitor server を起動
cd ../Excubitor
npm install
npm run dev
```

http://localhost:17331/health で動作確認。

## ラテン語の名前

**Excubitor** — ラテン語で「見張り」「警備兵」。ローマ皇宮警備隊 Excubitores の単数形。
short code: `Ex`。

## リポ構成 (v0.1 scaffold)

```
Excubitor/
├── README.md
├── package.json               # backend (Hono + Drizzle)
├── tsconfig.json
├── catalog/
│   └── services.yaml          # LUDIARS サービス定義 (source of truth)
├── migrations/                # excubitor DB スキーマ (連番 SQL)
├── spec/v0.1-design.md        # 設計書
├── src/                       # backend サーバ実装
│   ├── index.ts
│   ├── catalog/ scanner/ control/ process/ log/ infisical/ db/
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
- `port`: frontend dev server port (default 17332)
- `backendUrl`: backend (Excubitor server) の URL (default http://localhost:17331)

機密値はここに置かない (公開ドメインや port 等のみ)。
