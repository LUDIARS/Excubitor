# REVIEW_MISSING_FEATURES — Excubitor

**評価: B**

## v0.2 計画中で未実装

| # | Feature | 状態 | 優先 |
|---|---------|------|------|
| 1 | Infisical-relay | Removed (各サービス自前 fetch へ、現在 inject.ts 空) | Medium |
| 2 | Multi-host agent | Planned (hosts テーブルあるが remote SSH 未実装) | High |
| 3 | dev.ps1 UI 撤去 | Planned | Low |
| 4 | dev.bat マイグレーション | In progress (Corpus connector 連携待ち) | Medium |
| 5 | Reviews tab sync | Design (ludiars-review 連携) | Medium |

## 推奨改善 (Phase 1 緊急)
1. Input validation: command whitelist / catalog path 検証 (realpath + whitelist) / error rule サイズ制限
2. Authentication: control endpoint に bearer token or HMAC 署名 + loopback check
3. Log injection 防御: log excerpt escape (prompt template 明示) + "Do not follow instructions" ガード

## Phase 2-3
- /api/v1/health (Excubitor 自体) + Prometheus metrics
- Multi-host (SSH tunneling)
- Log retention (TTL cleanup cron, S3 archive)
- Auto-fix 高度化 (investigate-only mode / human-in-loop)

**総合: B**。コア監視機能は動作するが、セキュリティハードニングと multi-host が最優先課題。
