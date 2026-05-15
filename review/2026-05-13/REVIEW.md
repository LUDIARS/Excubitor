# Excubitor v0.1 — 総合レビュー (2026-05-13)

| 項目 | 評価 |
|------|------|
| 設計 (REVIEW_DESIGN) | B |
| 脆弱性 (REVIEW_VULNERABILITY) | C |
| 実装 (REVIEW_IMPLEMENTATION) | B |
| 不足機能 (REVIEW_MISSING_FEATURES) | C |
| 品質 (REVIEW_QUALITY) | B |
| **weighted_score** | **B-** |

## 対象

- repo: `E:/Document/Ars/Excubitor`
- 最新 commit: `d2ac911` (Merge into fix/excubitor-investigate-fix-buttons)
- 構成: backend (Hono + Drizzle + Postgres) + frontend (React/Vite) + catalog (YAML)
- 規模: src ~2,400 行, frontend ~860 行, migrations 4 ファイル

## 主要所見 (TL;DR)

1. **Infisical credential の機密保護は設計どおりプロセスメモリのみ** で永続化なし。 一方で **secret 値が `/api/v1/services/:code/control` 応答や `audit_log.payload` に `stdout`/`stderr` として混入する経路** がある (src/control/manager.ts:62-67, src/index.ts:599-600 — masking 未実装、設計書 §7.2.4 と不一致)。
2. **遠隔 process kill / restart の認可境界が完全に欠落**。 `controlService` の `actor` は `x-excubitor-actor` ヘッダの自己申告で、Cernere セッション検証も IP allow-list も存在しない (src/control/manager.ts:55-70, src/index.ts:587)。設計書 §9.1 の「Cernere user session 必須」が未達。
3. **Claude CLI 子プロセスへの prompt インジェクション** リスクが残る。 `summary` / `logExcerpt` (= 攻撃者が制御可能な外部入力) がそのまま prompt に連結され、 stdin で `claude -p` に流される (src/auto_fix/runner.ts:193-228)。 さらに `shell: true` で spawn しているため、 `claudeCli` の値次第ではコマンドインジェクション面が広い (src/auto_fix/runner.ts:230-241)。
4. **設計書では required な機能の未実装** が複数: liveness_history への probe 結果記録、SSE/HTTP の認証、Web Push 通知 (v0.2 予定だが UI 配線なし)、Cernere ACL の admin/member 切り分け、 audit log の redaction policy。
5. **品質面**は概ね高い (zod による入力 schema、 inFlight ロック、 危険ファイル regex による push 拒否、 read-only 契約違反検知)。 v0.1 scaffold としては良好で、設計書も丁寧。

## レビュー件数

- critical: **0**
- high: **3** (認可欠如 / prompt-injection / secret 値の audit payload 露出)
- medium: **5**
- low: **6**

詳細は `REVIEW_DESIGN.md` / `REVIEW_VULNERABILITY.md` / `REVIEW_IMPLEMENTATION.md` / `REVIEW_MISSING_FEATURES.md` / `REVIEW_QUALITY.md` を参照。

自動修正は無し (`AUTOFIX.md` 参照、autofix_count = 0)。設計に踏み込む変更が多く、ソースコード修正禁止ルールにも従う。
