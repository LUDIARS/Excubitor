# Excubitor — obsolete (2026-05-17)

このリポジトリは 2026-05-17 をもって obsolete になりました.

機能はすべて [LUDIARS/Concordia](https://github.com/LUDIARS/Concordia) の `src/observability/`
配下に集約されています. 新規開発・バグ修正は Concordia 側で行ってください.

## Concordia 内での対応

| 旧 Excubitor | 新位置 |
|--------------|--------|
| `src/catalog/` | `Concordia/src/observability/catalog/` |
| `src/scanner/` | `Concordia/src/observability/scanner/` |
| `src/control/` | `Concordia/src/observability/control/` |
| `src/process/` | `Concordia/src/observability/process/` |
| `src/log/` | `Concordia/src/observability/log/` |
| `src/auto_fix/` | `Concordia/src/observability/auto_fix/` |
| `src/reviews/router.ts` | `Concordia/src/observability/reviews/router.ts` |
| `catalog/services.yaml` | `Concordia/catalog/services.yaml` |
| `src/infisical/` | **廃止**. 各サービスが自前で Infisical fetch する設計に変更 |
| frontend (Dashboard / Errors / Reviews) | `Concordia/web/src/pages/{Catalog,Errors,Reviews}.tsx` |

## DB 変換

旧 Postgres + drizzle-orm/pg-core (`migrations/*.sql` 4本) は Concordia の
`src/db/schema.ts` に SQLite 化して取り込まれました (SCHEMA_VERSION 7→8).

## 過去データ

- `review/<YYYY-MM-DD>/` ディレクトリは Excubitor 自身のレビューデータとして残置
- git 履歴は archive 用に保持
