# REVIEW_DESIGN — Excubitor

**評価: B**

## アーキテクチャ

| 観点 | 評価 | 所見 |
|------|------|------|
| 責務分割 | A | Concordia (AI 協調) vs Excubitor (監視) が明確に分離 |
| Catalog 中心設計 | A | services.yaml を source of truth に全機能が依存 |
| 層状構造 | B | catalog → scanner/control/log/process が独立だが error_detector ← error_rules の結合が強い |
| 拡張性 | B | hub router (Corpus backend) 設計済だが multi-host 未実装 |
| 復旧可能性 | B | audit log + SQLite だが restart_policy ⇄ error_task の sync 不足 |

## データフロー
catalog/services.yaml → services/service_instances → scanner loop → service_instance_logs → error-detector → error_tasks → UI/auto-fix → controlService (restart) → ループ

**観察**: 線形だが error state 突発に対する異常復旧 flow が薄い (crash → restart_policy → exit_code → error_task の逆リンクが弱い)。

## 懸念
- error_detector ← catalog の遅延依存で rule reload (30s) と catalog watch の sync 不足
- auto_fix ← control の直呼び出し → 失敗時 verify 前の状態遺棄

**総合: B**。責務分割は秀逸だが、認証境界と error 復旧フローの設計が要強化。
