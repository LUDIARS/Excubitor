---
task: viewer-mobile-menu-verification
project: Excubitor
kind: テスト
created: 2026-09-10
memory_links:
  - spec/plan/problem_logs/2026-09-10-viewer-mobile-menu-layer.md
---
# スマホViewerメニューの表示確認

## 目的

独立した背景色と重なり順によって、スマホでメニューがページの手前に不透明表示されることを確認する。

## 完了条件

- 本体のDMZ成果物が対象修正を含むことを確認する。静的配信のため不要な再起動は行わない。
- 人間の実機確認、または明示許可されたブラウザ確認で、両Viewerホストのスマホ幅表示を確認する。
- メニューの視認、選択、背景タップで閉じる、開閉後のiframe状態維持を確認する。
- HTTP成功と実画面確認を区別して記録する。テスト時はCc claim/releaseを行う。

## スコープ (編集可ディレクトリ)

原則編集なし。問題が残ればfrontend/src/viewerを別worktreeで修正する。
進行状態はCcに記録し、この文書に書き戻さない。
