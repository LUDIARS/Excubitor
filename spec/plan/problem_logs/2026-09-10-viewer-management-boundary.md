# 統合Viewerが管理プロセスと同一入口に存在する

- Date: 2026-09-10
- Status: fixed in working tree; runtime verification not run
- Area: Viewer / Ex management boundary

## Summary / Evidence

ユーザーは統合ビューとワーカーをDMZとして管理フロントから別プロセス化するよう指定。
従来はsrc/index.tsにViewerと設定・制御・MCP APIを同居させ、src/server.tsがViewer upgradeを処理。
frontend/src/main.tsxもURL条件で同じbundleからMonitorとViewerを選択していた。
外部経路の設定次第で管理機能も同じ入口に到達する構造で、DMZ分離がなかった。
侵入・漏洩の実発生は未確認。回帰と断定する根拠もない。

## Cause / Fix Requirements

統合Viewerの配備単位をEx管理側と共用していた。専用ワーカー、専用UI成果物、
公開対象だけの期限付きmanifestへ分離し、DBや秘密設定をワーカーの実行依存から除く。
Cloudflare Accessは適切と仮定。PC内からのアクセスは信頼し、loopback待受を維持する。

## Verification / Follow-up

単体・統合・起動テストはユーザー未指示につき実行しない。
受入項目と配備順序はspec/feature/viewer-dmz.md。PR提出後停止し、配備は別途承認後。
