---
task: viewer-service-activation
project: Excubitor
kind: テスト
created: 2026-09-10
memory_links:
  - spec/feature/unified-viewer.md
  - spec/feature/viewer-dmz.md
---
# 追加4サービスのViewer稼働確認

## 目的

Anatomia、Genius、Quaestor Web、Memoriaの既存画面を両Viewerホストで利用できることを確認する。

## 完了条件

- 各本体catalogのviewer opt-inとWeb入口を確認する。URLとportはcatalogから解決する。
- 起動・再起動・テストは明示許可後、Cc claimを行い、Excubitor経由で本体フォルダから実施する。
- GeniusのGENIUS_ALLOWED_ORIGINSが稼働プロセスへ反映されていることを確認する。
- https://web.ai-run-do.com と https://exiv.ai-run-do.com で一覧、HTML、JS/CSS、初期API、実画面を確認する。
- Quaestor Webの既存API中継とhash遷移を確認する。データ変更操作は別途許可範囲を確認する。
- 確認範囲と未確認点を報告し、claimをreleaseする。

## スコープ (編集可ディレクトリ)

原則編集なし。Ex管理画面追加、Cloudflare設定変更は含まない。
サービス固有修正が必要なら当該repoの専用worktreeで行う。
進行状態はCcに記録し、この文書に書き戻さない。
