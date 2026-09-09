---
task: viewer-client-contract
project: Excubitor
kind: 実装
created: 2026-09-09
memory_links:
  - spec/plan/frontend-unification.md
  - spec/plan/viewer-target-inventory.md
---
# Viewer の共通クライアント契約を実装する

## 目的

フロントエンドのルーティング・通信 URL・Viewer 判定を Ex 所有の共通機構へ統一し、個別サービスへの互換コード複製を止める。

## 完了条件

- 設計書の v1 context、framework 非依存 core、v0 adapter、独立 router adapter を実装する。
- standalone と Viewer を明示的に区別し、不正 context や未登録接続先を fail-fast で拒否する。
- context JSON を実行可能な JavaScript へ連結せず安全に埋め込み、URL 関数では scheme/authority、先頭 slash、backslash、raw/percent-encoded の親ディレクトリを拒否し、正規化後も URL が許可された base path 内にあることを検証する。
- Ex shell が唯一のサービス移動メニューを所有し、対応済みアプリへ旧 monkey patch と namespace を二重適用しない。
- 既存社内 package 配布方法に合わせて版固定の利用方法を整備し、隣接リポへの file 依存を作らない。
- 利用側 Cc/Pf/Pe の移行は共通パッケージ配布後、各リポへ branch 確認・Cc 登録して独立実装タスクを新規保存する。
- セキュリティ除外対象に対する origin/CSP/認証緩和を含めない。

## スコープ (編集可ディレクトリ)

- packages/viewer-client/
- src/viewer/
- frontend/
- spec/feature/、spec/architecture/
- パッケージ配布に必要な Ex の manifest 設定。

## 制約

実装 PR まで。テスト・起動・マージは明示許可を得る。進行状態は Concordia DB に保持し、このファイルを更新しない。
