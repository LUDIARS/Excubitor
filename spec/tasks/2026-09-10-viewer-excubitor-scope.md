---
task: viewer-excubitor-scope
project: Excubitor
kind: 設計相談
created: 2026-09-10
memory_links:
  - spec/feature/viewer-dmz.md
---
# Ex自身をViewerへ載せる範囲の確認

## 目的

利用者が望む既存Ex画面の閲覧範囲と操作範囲を確認し、DMZ分離を保った公開経路を具体化する。

## 完了条件

- ViewerでExの起動・停止・設定変更も必要かを人間に確認する。
- 独自の要約画面への置き換えを合意なく行わない。
- 合意した画面、API、認可境界、管理経路との関係、受け入れ条件を設計する。
- 管理API非公開という既存契約から変更する部分があれば明示し、未合意のまま公開しない。

## スコープ (編集可ディレクトリ)

spec/feature、spec/interface。実装・サービス操作・Cloudflare変更は含まない。
進行状態はCcに記録し、この文書に書き戻さない。
