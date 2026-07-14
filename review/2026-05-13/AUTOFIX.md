# AUTOFIX — Excubitor (2026-05-13)

autofix_count: **0**

本レビューはソースコード修正禁止ルールに従い、 安全範囲の自動修正は一切行わない。 以下は **将来の自動修正候補** の列挙のみ。

## 候補 (自動修正は実施しない)

| # | 種別 | 箇所 | 内容 | リスク |
|---|------|------|------|--------|
| AF-1 | typo | `frontend/config.ts:25-27` | `allowedHosts` の `excubitor.vtn-game.com` を `excubitor.example.com` 等に汎用化、 または `.gitignore` で除外 | low |
| AF-2 | dead code | `src/log/error-detector.ts:14-17` | コメントアウト済みの `maybeTriggerAutoFix` import 行を削除 | low |
| AF-3 | dead code | `src/log/error-detector.ts:36-39` | `setCatalogProvider` / `catalogProvider` 変数が使われていないため削除 (もしくは TODO) | low |
| AF-4 | unsafe error narrowing | `src/auto_fix/runner.ts:155, 159-162, 178-180`, `src/process/manager.ts:107, 161` etc. | `(err as Error).message` → `err instanceof Error ? err.message : String(err)` | low |
| AF-5 | docstring 補足 | `src/infisical/filter.ts` | include / exclude / prefix の評価順序を JSDoc に明文化 | low |
| AF-6 | hardcoded magic number | `src/auto_fix/config.ts` / `src/log/error-detector.ts:33` / `src/scanner/loop.ts:10` | `autoFixConfig` 同様に `excubitorTuning` 等で集約 | low |
| AF-7 | sync I/O → async | `src/reviews/router.ts:50-74` | `fs.promises` 化 (機能変更なし) | low |
| AF-8 | typo / 中黒 | 各種 pino logger 中の日本語コメント | 表記揺れ統一 (例: 「子プロセス」 / 「childプロセス」) | low |

これらは「安全範囲」 内の修正で、 ludiars-review skill が同一日付ブランチで 1 PR にまとめる候補となり得る。 本レビュー実行時は **指示通り列挙のみ**。

## 自動修正しなかった理由

- 指示文「ソースコード修正禁止」 / 「AUTOFIX は列挙のみ (autofix_count=0)」 に従う。
- 本レビューで指摘した high 級 (V-1 認可、 V-2 prompt injection、 V-3 secret 漏洩、 M-1 liveness probe) は安全範囲を超えるため、 もとより自動修正の対象外。
