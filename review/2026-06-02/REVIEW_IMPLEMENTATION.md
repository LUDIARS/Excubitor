# REVIEW_IMPLEMENTATION — Excubitor

**評価: B**

## コード品質

| 項目 | 評価 | 所見 |
|------|------|------|
| 型安全性 | A | TypeScript + Zod 全般的に良好 |
| エラー処理 | B | try-catch 包括的だが一部 silent fail (log/file-tail.ts 未確認) |
| ロギング | A | 一貫した pino + createNamedLogger |
| テスト | D | unit test ほぼ無し (hub/router.test.ts のみ) |

## 主要イシュー
1. Silent failures: auto_fix/runner.ts:169 で void spawn().catch() → 修正失敗が log のみで状態未更新
2. Unchecked JSON parsing: index.ts:112-113 で JSON.parse(catalog_snapshot) の例外未処理
3. Race conditions: inFlight Set (runner.ts:38) と restart_policy + auto_fix の競合

## データスキーマ
- services / service_instances / error_tasks / auto_fix_runs / audit_log
- 課題: error_tasks ↔ auto_fix_runs の同期 (transaction or event-driven)、service_instance_logs の TTL なし (無制限増加)、catalog_snapshot の staleness (実ディスクと DB drift)

## SRE
- Health endpoint 未設定 (Excubitor 自体の :17332/health なし)
- Process manager shutdown に graceful timeout なし
- Scanner loop backpressure (遅い git repo で全 observability 遅延)

**総合: B**。型安全・ロギングは良好。テスト不足とデータ同期/SRE が課題。
