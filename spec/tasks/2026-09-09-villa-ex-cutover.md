---
task: villa-ex-cutover
project: Excubitor
kind: 雑用
created: 2026-09-09
memory_links: []
---

# Villa の配信を Ex に切り替える

## 目的

Ex 所有の `villa/` と `/villa/` 配信へ移行し、旧 Villa サービスへの運用依存を解消する。参照仕様は、統合 Viewer の変更で追加予定の Excubitor `spec/feature/unified-viewer.md` とし、同仕様が取り込まれてから着手する。

## 完了条件

- 旧 Villa の HTML・routes と Ex に収容した資料の差分を確認し、移行対象と除外理由を一覧化する。公開可否が確認できた資料だけを移す。セッション運用ログ、機密資料、元資料がリポジトリ収容を禁じる内容は配布物へ戻さない。
- Ex 配布物に必要な `villa/` と `frontend/dist` が含まれることを確認し、既存 URL・route・参照リンクの対応表と切替・復旧手順を用意する。
- 統合確認の完了後、公開先の切替と旧サービス停止について明示許可を得る。許可された設定だけを変更し、旧入口から Ex `/villa/` への到達と資料表示を確認する。
- 到達確認後に旧 Villa を Excubitor 経由で停止し、所有リポの catalog 設定で自動起動を無効化する。旧資料の削除は含めない。
- 変更した公開先、確認結果、復旧に必要な情報をセッションへ添付共有する。API 受付と配送確認を区別する。

## スコープ (編集可ディレクトリ)

- Excubitor の `villa/`、`spec/plan/`、必要な配布設定。
- 旧 Villa の所有リポと公開経路の設定は、実 checkout branch の確認・Cc 登録および切替許可後に、対象箇所だけ変更する。

## 制約

開始前に現在の旧 Villa 管理元と公開経路を調べ、推測で切り替えない。ポートは catalog / ProcessMap から解決する。テスト・再起動は別途許可を要し、Concordia claim/release とプロジェクト本体限定の運用に従う。進行状態は Concordia DB に保持する。
