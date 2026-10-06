---
task: "Per-site daily repository updates with deployment recovery"
project: Ex
kind: task
created: 2026-10-06
memory_links: []
---

neco 指示: 各拠点で毎朝全リポジトリを pull、更新があったサービスを最新でビルド・再配置するオプションを追加する。起動失敗は旧版にフォールバックし、復旧にも失敗した場合はエラー通知する。

仕様: spec/feature/daily-site-deploy.md (SPEC-EX-DAILY-SITE-DEPLOY)。拠点ごとの既定無効設定、supervisor 実行、永続復旧 journal、稼働状態保持、dirty/ahead checkout 保護、排他と復旧失敗通知が受入条件。実拠点での有効化はこの機能追加と分離する。
