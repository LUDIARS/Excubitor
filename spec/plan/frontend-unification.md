# Ex Viewer フロントエンド共通機構の設計

作成: 2026-09-09。対象: Excubitor。依頼条件は「フロントエンドの機構は統一」「セキュリティ関係で除外しているものを除く」。本書は設計成果物であり、実装済みの宣言ではない。

## 採用方針

Ex が共通シェルを所有し、対象サービスは共通のブラウザ用クライアント契約を使う。ルーティング、API 接続先解決、Viewer 判定をサービスごとに複製しない。業務画面・データ・認証は各サービスが所有する。

既存 React/Vite アプリと素の HTML/JavaScript の両方を同じ契約で扱う。Pagus の Pixi.js 等を React に置き換える必要はない。統一対象は入口・通信・ナビゲーションの機構であり、今回の設計では全 UI のフレームワーク置換は採用しない。

## 現状と移行先

| 責務 | 現状の参照 | 移行先 |
|---|---|---|
| サービス切替 UI | Ex `frontend/`、Viewer shell | Ex のみ。サービス内に同じメニューを配布しない |
| ルーターベースパス | Cc/Pf/Pe の script data-prefix 読取 | 共通クライアントの `routeBase` を router adapter が使用 |
| fetch/XHR/WS/History 等 | Ex `frontend/public/viewer/` の互換処理 | 新対応アプリは明示的な共通 API を使用。互換層は移行期間のみ |
| 許可対象・接続先 | Ex `src/viewer/catalog.ts` | Ex の server-side 判定を正本として維持 |
| 文書 URL と cookie 変換 | Ex `src/viewer/rewrite.ts` / `headers.ts` | reverse proxy の責務として保持。クライアントへ移さない |
| Villa | Ex `src/villa/documents.ts` / `villa/` | Ex 所有の静的 HTML 配信。共通シェルから選択可能 |

参照する Viewer 実装は `feat/unified-viewer-villa` のレビュー修正を含む版。本体への反映とは区別する。Cc/Pf/Pe の既存ベースパス変更は移行の出発点として利用し、同じ一行修正を再提出しない。

## 配置と依存

Ex リポの `packages/viewer-client/` を共有クライアントの所有場所とし、公開名を `@ludiars/viewer-client` とする案を採用する。core は DOM 標準 API と型定義だけで動く ESM とし、React/router 対応は独立 export に分離する。Ex backend を import しない。

利用側には版固定の配布パッケージを届ける。既存の社内 package 配布経路を実装時に確認し、配布前に利用側依存を書き換えない。隣接 checkout の `file:../Excubitor` 依存や各サービスへのソース複製は作らない。素の HTML には同じ成果物の ESM を配布し、別実装を作らない。

## ブートストラップ契約 v1

Ex が HTML に同一 origin の context JSON を埋め込む。フィールドは `version: 1`、`serviceCode`、`routeBase`、`assetBase`、`apiBases`（論理名から許可された path への対応）、`mode: viewer`。既存 data-prefix は移行期間の v0 adapter が読む。任意 URL・port・外部 origin は契約に入れない。context は実行可能な JavaScript へ文字列連結せず、`application/json` の script 要素等から `textContent` として読む。HTML に埋め込む際は `<` を JSON の Unicode escape に変換し、`</script>` による要素終端を防ぐ。

共通クライアントの初期化は以下の規則で一度だけ行う。

- context が存在しない直接起動は `mode: standalone`。各サービスの明示的な既存接続設定を使う。未設定の必須 API はエラーにする。
- context があるのに version・code・path が不正な場合は初期化エラーとし、直接起動へ黙って切り替えない。
- `routeBase`、`assetBase`、`apiBases` の各値は Ex server が生成・検証する同一 origin の絶対 path とする。`routeBase` は `/viewer/apps/<serviceCode>` と整合し、正規化済みであることを必須とし、親ディレクトリ・二重 slash・backslash・別 origin を許さない。
- context は表示・URL 解決の入力であり認可証明ではない。改ざんされても Ex server の catalog 判定を迂回できないことを必須とする。
- 共通クライアントは `routeBase`、`assetUrl(relativePath)`、`apiUrl(logicalName, relativePath)`、`socketUrl(logicalName, relativePath)` を提供する。各 URL 関数は相対 path だけを受け付け、scheme、authority、先頭 slash、backslash、raw/percent-encoded の親ディレクトリを拒否する。query/hash は構造化 URL として保持し、正規化後の URL が許可された base path 内にあることを再検証して二重 prefix と base path 逸脱を防ぐ。外部認証 URL は別の明示 API とし、内部 proxy へ変換しない。

別 frontend/backend 構成は catalog の同一 project で明示許可された接続だけを `apiBases` へ載せる。未登録 API は接続エラーとする。WebSocket/SSE はその URL 解決を利用し、所有コンポーネントの破棄時に close/abort する。

## ルーター・シェル・状態

React Router は共通 adapter の basename を使用する。React Router の世代差は adapter のみに閉じ込め、サービスコードで script 要素を直接検索しない。非 React アプリも同じ routeBase と URL 関数を使う。Vite の build asset base とランタイム API base は別責務として扱い、開発用 origin を bundle に焼き込まない。

サービス切替メニューは Ex shell が描画する。直接起動ではメニューが存在せず、Viewer への自動転送も行わない。shell と iframe の連携が必要な場合は version 付きメッセージを用い、origin に加え送信元 window と選択中 code を照合する。メッセージに任意遷移 URL を受け付けない。

cookie の名前/Path 隔離は Ex、localStorage/sessionStorage の namespace は共通クライアントが所有する。互換層と共通クライアントを同時に適用して二重 namespace 化しない。直接アクセスの既存認証状態の自動移送はしない。Service Worker は Viewer 内では登録せず、他サービスや直接起動の登録を解除しない。

## セキュリティ除外

対象一覧は `viewer-target-inventory.md`。既存の loopback、WebAuthn origin、frame-ancestors、X-Frame-Options、公開入口の認証を統一のために緩めない。除外されたサービスへ共通クライアントを導入することも今回の移行対象から外す。

同一 origin のパスは悪意あるコード間の隔離境界ではない。掲載許可がないアプリを iframe へ読み込まない。Ex shell・管理 API と同じ信頼範囲に置けるかを対象ごとに確認し、catalog の opt-in はその後に行う。許可なし・除外理由ありは HTTP/WS 双方で拒否する。

## 実装単位と受入条件

1. Ex: 共通クライアント core、v1 context、v0 adapter を実装。直接起動・Viewer・不正 context の結果を固定する。context の安全な埋め込みを保証し、外部 URL/未登録 API/二重 prefix/base path 逸脱を拒否する。
2. Ex: shell と proxy が共通契約を生成。対応済み宣言があるアプリには旧 fetch/History 等の monkey patch を適用しない。未対応アプリは既存互換層のままとし、移行状況を catalog の明示契約で選ぶ。
3. Concordia / Praeforma / Peregrinatio: 共通パッケージ配布後、既存 basename 対応・API 解決・アセット参照を同じ契約へ移す。各所有リポで独立 PR。Peregrinatio の PWA は standalone のみ登録する。
4. 候補サービス: 一覧の保留条件解消後に同じ契約へ移す。新たな例外処理が必要なら共通契約に適合するかを先に判定し、セキュリティ除外を回避しない。

実装タスクの起点は Ex `spec/tasks/2026-09-09-viewer-client-contract.md`。利用側の実装開始・対象設定の有効化は本設計作成には含めない。単体・統合・起動テストは明示許可後に実施する。
