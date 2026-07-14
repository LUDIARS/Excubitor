# AUTOFIX.md — Excubitor (2026-06-02)

## 概要
- 修正ファイル数: 0
- 変更行数: +0 / -0
- カテゴリ別件数: lint=0 / typo=0 / unused_import=0 / dead_code=0 / gitignore=0 / toc=0 / critical_high=0
- 関連 PR: なし
- 備考: 本日の自動修正対象は 0 件。Critical (RCE / prompt injection) と High の大半は command whitelist / 認証 middleware / path 検証など設計判断・挙動変更を伴い、運用コアのためローカル green 確認が必要。bounded 候補 (security header / body size 制限) も挙動影響があり手作業に回した。

## カテゴリ別
本日該当なし。

## フラグしたが手作業に回した指摘
- `src/process/manager.ts:91` — shell=true + 未検証 command の RCE。command whitelist or shell=false + safe split (Critical / 設計判断)。
- `src/auto_fix/runner.ts:193-227` — log excerpt の prompt injection。escape + `<error_log>` ブロック化 + ガード文 (Critical)。
- `src/index.ts:328-349` — control endpoint に bearer/HMAC + loopback check (High / 認可設計)。
- `src/catalog/loader.ts` — cwd/compose_file の realpath + whitelist 検証 (High)。
- `src/log/error-detector.ts:42-84` — regex 長さ制限 / safe-regex 検証 (High / ReDoS)。
- `src/index.ts:306-326` — error rule body サイズ / service_codes 配列長制限 (High / DoS)。
- `src/index.ts` — CORS/CSP セキュリティヘッダ追加 (Medium、bounded だが挙動影響あり要検証)。
- (取り下げ) migrations/004_action_type.sql — 実体確認の結果 IF NOT EXISTS で冪等、修正不要。
- テスト基盤新設 (大型)。

## 関連
- レビュー全文: REVIEW.md / REVIEW_*.md
