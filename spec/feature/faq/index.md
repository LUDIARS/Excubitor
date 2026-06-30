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

<!-- tag: env -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

<!-- tag: global-env -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

<!-- tag: vite -->
- [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) `vite` `allowedHosts` `env` `global-env` `melpot`

## 一覧 (新着順)

| 日付 | タイトル | タグ |
|---|---|---|
| 2026-06-30 | [Vite dev server で `*.melpot.dev` がブロックされる](allowedhosts-global-env.md) | `vite` `allowedHosts` `env` `global-env` |
