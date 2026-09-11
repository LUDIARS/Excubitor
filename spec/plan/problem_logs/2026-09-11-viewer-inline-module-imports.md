# ViewerでQuaestorが開けない

- Date: 2026-09-11
- Area: Viewer HTML rewrite
- Status: fixed in working tree

## Evidence

利用者からQsが開けないとの報告。稼働中のQuaestor WebとViewerのHTML応答はともに200だが、Viewer応答内のVite React refresh preambleは `import ... from "/@react-refresh"` のままだった。外部moduleのsrcは正しく `/viewer/apps/quaestor-web/` 配下に変換されていた。

## Cause and fix

`src/viewer/rewrite.ts` の `rewriteHtml` はscript本文を退避して無変更で復元していた。inline moduleの静的importはruntimeのfetch補正を通らず、React refresh初期化が失敗する。`type="module"` の本文にも既存 `rewriteModules` を適用する。classic script、JSON、文字列、コメントは従来どおり保存する。

## References

Anatomia登録project `excubitor` のcontextを照合。既存domainはviewer/frontend-ui。仕様正本は `spec/plan/frontend-unification.md`（互換層とURL解決）、実装は `src/viewer/rewrite.ts`。初期HTMLの200だけでは画面成立を確認できない回帰。

## Verification

ユーザーのテスト実行指示はないためテスト未実行。審査ではinline static/dynamic import、classic scriptとJSON保持、二重prefix防止を確認する。反映後は両Viewer originでReact初期化とQs画面を確認する。端末の表示確認は未実施。
