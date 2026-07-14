# Excubitor FAQ 目次

調査・質問が発生したときに残す知識ベース。セッション起動時には読まず、
必要になったときに参照する。新規 FAQ は `spec/faq/<slug>.md` に追加し、
この index に 1 行エントリとタグを追記する。

### 対象コンテンツ

| 種別 | 例 |
|---|---|
| **問題・エラー** | `Blocked request` / 起動失敗 / ポート衝突 |
| **調査結果** | 「env 注入の優先順位はどうなっているか」「catalog reload のフローを追った」 |
| **よくある質問** | 「global.env とサービス固有 env の違いは」「federation はどう認証するか」 |
| **設計の背景** | なぜこのアーキテクチャを選んだか、廃案になった案 |

## フォーマット

各 FAQ ファイルの先頭に frontmatter を置く:

```markdown
---
tags: [tag1, tag2]
date: YYYY-MM-DD
kind: problem | investigation | qa | design
---

# Q: <質問 / テーマ>

## 背景 / 症状
...

## 結論 / 解決策
...

## 詳細
...
```

`kind` は目安程度。タグで検索するので省略可。

## タグ索引

<!-- tag: allowedHosts -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

<!-- tag: crash -->
- [Excubitor クラッシュ多発問題 — コード解析](crash-2026-07-analysis.md) `crash` `stability` `ops`
- [WP1: service-runner 道連れ shutdown 廃止 / ハンドラ内 throw 対策 / docker ps timeout](crash-fix-wp1-supervisor.md) `crash` `service-runner` `server` `scanner`
- [WP2: 子プロセス管理の共通化](crash-fix-wp2-child-process.md) `crash` `exec` `child-process` `auto_fix` `process-manager`
- [WP3: ログ系の無制限バッファ対策](crash-fix-wp3-log-buffers.md) `crash` `log` `sse` `oom`
- [WP4: DB 衛生](crash-fix-wp4-db-hygiene.md) `crash` `sqlite` `retention` `db`

<!-- tag: stability -->
- [Excubitor クラッシュ多発問題 — コード解析](crash-2026-07-analysis.md) `crash` `stability` `ops`

<!-- tag: child-process -->
- [WP2: 子プロセス管理の共通化](crash-fix-wp2-child-process.md) `crash` `exec` `child-process` `auto_fix` `process-manager`

<!-- tag: log -->
- [WP3: ログ系の無制限バッファ対策](crash-fix-wp3-log-buffers.md) `crash` `log` `sse` `oom`

<!-- tag: sqlite -->
- [WP4: DB 衛生](crash-fix-wp4-db-hygiene.md) `crash` `sqlite` `retention` `db`

<!-- tag: env -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

<!-- tag: global-env -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

<!-- tag: vite -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

## 一覧 (新着順)

| 日付 | タイトル | タグ |
|---|---|---|
| 2026-07-09 | [Excubitor クラッシュ多発問題 — コード解析](crash-2026-07-analysis.md) | `crash` `stability` `ops` |
| 2026-07-09 | [WP1: service-runner 道連れ shutdown 廃止ほか (最優先)](crash-fix-wp1-supervisor.md) | `crash` `service-runner` |
| 2026-07-09 | [WP2: 子プロセス管理の共通化](crash-fix-wp2-child-process.md) | `crash` `exec` `child-process` |
| 2026-07-09 | [WP3: ログ系の無制限バッファ対策](crash-fix-wp3-log-buffers.md) | `crash` `log` `sse` `oom` |
| 2026-07-09 | [WP4: DB 衛生](crash-fix-wp4-db-hygiene.md) | `crash` `sqlite` `retention` |
| 2026-06-30 | [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) | `vite` `allowedHosts` `env` `global-env` |
