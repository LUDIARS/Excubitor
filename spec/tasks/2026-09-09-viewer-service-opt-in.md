---
task: viewer-service-opt-in
project: Excubitor
kind: 設計相談
created: 2026-09-09
memory_links: []
---

# Viewer 掲載対象と所有リポジトリの設定を確定する

## 目的

Ex の単一 URL から対象サービスへ移動できるように、明示許可制の Viewer に掲載するサービスと必要な設定変更を確定する。設計の参照先は、統合 Viewer の変更で追加予定の Excubitor `spec/feature/unified-viewer.md` とし、同仕様が取り込まれるまでは掲載可否や変更内容を確定しない。

## 完了条件

- 各所有リポジトリの `excubitor.catalog.yaml` と現在のフロントエンド構成を照合し、対象サービス、サービスコード、掲載可否、理由、必要な所有リポ側変更を一覧にする。
- `viewer.enabled: true` は Ex と同一 origin で実行してよい信頼範囲のサービスに限定する。ループバック必須の Ludellus / Interpres / Actio 等、および GLab 等の Corpus 系は対応対象から除く。
- Concordia / Praeforma / Peregrinatio の既存 BrowserRouter ベースパス対応を確認し、同じ変更を再実装タスクにしない。未対応箇所だけを所有リポごとの実装タスクへ分解する。
- 掲載候補の CSP・認証コールバック・絶対 URL・WebSocket 等の制約を静的に確認し、必要な確認項目を統合確認へ引き渡す。互換性のためにセキュリティ制約を解除しない。

## スコープ (編集可ディレクトリ)

- Excubitor の `spec/plan/`（対象一覧と設定案）。
- 他リポジトリは読み取りのみ。必要な変更タスクの新規保存は、対象リポの branch 確認と Cc 登録を行ってから、そのリポの `spec/tasks/` に限定する。

## 制約

このタスクではサービス設定の有効化、テスト、再起動、マージを行わない。進行状態は Concordia DB に保持し、このファイルへ書き戻さない。
