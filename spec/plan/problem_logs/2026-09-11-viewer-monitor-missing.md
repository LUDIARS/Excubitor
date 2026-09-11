# Ex自身のフロントビューがViewerにない

- Date: 2026-09-11
- Area: Viewer / frontend-ui
- Status: fixed in working tree

## Evidence and cause

necoからExのフロントビューが未対応との指摘。`src/viewer/catalog.ts` はExを管理API公開防止のため除外しており、閲覧専用の入口がなかった。過去のサービスopt-inだけではEx表示を提供できない。

## Fix

既存Monitorをsnapshot付き閲覧モードで再利用し、DMZの独立entryから表示する。管理プロセスが表示属性をschemaで射影して期限付きmanifestへ出版する。管理App自体を配信したり任意の管理APIをproxy対象に追加したりしない。

## References

Pf project一覧ではExcubitorは未登録。Anatomia登録project `excubitor` のcontextでviewer/frontend-uiと `spec/plan/frontend-unification.md` を照合。今回の具体契約は `spec/feature/viewer-monitor.md` のSPEC-VIEWER-MONITOR。

## Verification

Revisor #1695で既存テスト `keeps health responsive while the project downtime read is pending` が失敗。公開処理による不要な履歴取得が加わり、1回の取得契約が2回になっていた。表示read modelを既存APIと共用し、公開処理は履歴readerを渡さず表示属性のみを取得するよう修正。テスト条件は変更しない。

テスト・サービス起動は未実行。TypeScript確認とDMZビルドを行い、結果をPR提出時に報告する。審査では既存Monitor維持、閲覧入口、POST/未知path/秘密項目の非公開、manifest期限とpublisher停止後の挙動を確認する。実機表示は反映後の確認が必要。
