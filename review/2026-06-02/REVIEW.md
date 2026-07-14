# REVIEW (総合評価) — Excubitor (再稼働版)

| 項目 | 値 |
|------|-----|
| リポジトリ | LUDIARS/Excubitor |
| 分類 | Web サービス (監視・運用コア、port 17332/17333) |
| 対象 | main 直近 8 commit |
| レビュー実施日 | 2026-06-02 |
| **総合評価** | **C** |

## 概要
LUDIARS 全サービス死活監視・ログ集約・エラー検知・自動修復の中核。catalog (services.yaml source of truth) / scanner / control / process / log / auto_fix (Claude CLI spawn) / web UI / Corpus backend。責務分割は良好だが、**プロセス起動・コマンド実行・auto_fix の信頼境界が最重点課題**。

## 観点別評価

| 観点 | 評価 |
|------|------|
| 設計 | B |
| 脆弱性 | D |
| 実装品質 | B |
| 不足機能 | B |
| 品質保証 (テスト D) | C |

## 重大指摘 (Critical 2 / High 4)
- **Critical**: process spawn の shell=true + 未検証 catalog command (RCE) / auto_fix の log excerpt → Claude CLI prompt injection
- **High**: control endpoint 無認証 / catalog path (cwd/compose_file) 未バリデーション / error detector regex 無制限 (ReDoS) / error rule body サイズ無制限 (DoS)
- (取り下げ) migration 004 冪等性: 実体確認の結果 IF NOT EXISTS で冪等に実装済

> 注: 監視・運用コアは loopback 前提で設計されているが、Corpus hub backend が 17332 を expose する計画があるため、信頼境界の明確化が必要。
