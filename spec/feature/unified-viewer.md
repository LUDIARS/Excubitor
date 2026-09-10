---
id: EX-UNIFIED-VIEWER
status: implemented-unverified
---

# Ex Viewer と Villa

2026-09-10: 公開・配備境界は [DMZワーカー仕様](viewer-dmz.md) に更新。
以下のViewer経路はEx管理プロセスではなく `excubitor-viewer-dmz` が提供する。
旧Villaホストからのredirectは不要。末尾の旧切替手順よりDMZ仕様を優先する。

複数のサービスのブラウザタブを探す手間を減らす。DMZ の `/viewer/` が共通の外枠を
所有し、検索付きのサービス切り替えメニューと iframe を表示する。直接サービスを
開いたときにはボタンも互換スクリプトも追加しない。

## 責務と経路

- `/viewer/?service=<catalog-code>`: サービス選択。ブラウザの戻る/進むに対応。
- `/viewer/apps/<catalog-code>/*`: HTTP 中継。転送先は信頼済みサービス catalog の
  `frontend_port` / `port` のみ。利用者入力の URL や port を転送先に採用しない。
- `/api/v1/viewer/services`: 公開許可済みの閲覧候補だけを返す。対象外の名前や理由、
  worker / native / infra はDMZへ渡さない。
- `/viewer/apps/villa/*`: Ex の `villa/` から資料を直接配信。Villa プロセスへの中継はしない。
- `/villa/`: Villa 閲覧経路への互換入口。メニューボタンは Viewer の外枠にのみ存在する。

`src/viewer/catalog.ts` は対象判定、`urls.ts` は経路解決、`headers.ts` は HTTP/Cookie 境界、
`proxy.ts` はストリーム転送、`rewrite.ts` は文書の URL 変換、`websocket.ts` は upgrade と
socket 寿命を所有する。業務データ・認証・サービス起動の所有は各既存サービスに残す。

## 対象外

neco の指定により Actio / Interpres / Ludellus とその派生、GLAB / Corpus 系は対象外。
Manus もローカル入力サービスとして対象外。catalog の `uses_corpus`、DB の有効な
Corpus 設定、Corpus への依存、`CORPUS_*` を使用する派生 hub も対象外とする。
一覧から選べないだけでなく HTTP と WebSocket の転送先解決も同じ判定で拒否する。

Viewer への掲載は所有 repository の catalog で明示的に許可する。同一 origin の iframe 内で
実行されるため、Ex の画面・API と同じ信頼範囲に置けるコードだけを opt-in する:

```yaml
viewer:
  enabled: true
```

`viewer.entry_path` は初期表示パス（既定 `/`）。転送先ポートはこの設定に増設しない。
対象外へ戻す場合は `viewer.enabled: false` とする。ループバック origin が必要なサービスは
`viewer.loopback_required: true` を指定する。
catalog のないサービスや、catalog 上のポートとは別に起動した画面は自動推測しない。

## URI 変更への対応

HTML の URL 属性、CSS の url()、JavaScript の絶対 module specifier を接頭辞付きへ変換。
互換スクリプトは fetch / XHR / WebSocket / EventSource / Worker / beacon / History と
DOM の URL setter をサービスの経路へ変換する。同じ project の catalog にある明示的な
loopback 接続先も変換する。他の URL は任意 proxy にしない。

BrowserRouter の basename は別途必要。Cc / Pf / Pe の小さな対応 PR は、Ex が注入する
`script[data-excubitor-viewer]` の `data-prefix` を読む。直接起動では属性が存在しないため
従来のルートを使用する。任意の JavaScript 文字列やルート定義を中継サーバで置換しない。

`Location.href/assign` の同一 origin 全画面遷移は Viewer の iframe load 時にサービス経路へ
戻す。外部の認証画面は独自 origin を保持する。認証 callback、CSP の埋込禁止、特殊な
URL 組立て、動的 import/HTML 生成の全組合せの互換性は実機確認が必要。
X-Frame-Options と frame-ancestors は削除せず、埋込禁止のサービスは無断解除しない。

## 状態と寿命

- Cookie の名前と Path をサービス単位に変換。Ex 自身や別サービスの Cookie は upstream に送らない。
- localStorage/sessionStorage は Viewer サービス単位に分ける。直接アクセス時のログイン状態とは別。
- Origin は偽装しない。loopback origin を要求するサービスを proxy で迂回しない。
- Service Worker は Viewer 内で登録させない。既存登録の一覧も渡さず他サービスの解除を防ぐ。
- HTML/CSS/JS は UTF-8、書換上限16 MiB。要求と書換読込は30秒で打切り。
  SSE/バイナリは全体を蓄積せず転送。WebSocket は両端切断・DMZワーカー終了時に解放する。
- 同一 origin のパス分割は、悪意あるコードに対するセキュリティ境界ではない。
  この Viewer は同じ信頼範囲の内部サービス用。DMZ入口のCloudflare Accessを適切に設定する前提。

## Villa の所有と移行

公開可能性を確認した既存 Villa の HTML と routes.json を Ex の `villa/` に収容する。
更新先は Ex の `villa/`。資料の業務上の正本は引き続き各プロジェクト。
HTML と routes.json は毎要求で読み直す。ルート外・symlink での脱出と非 HTML 公開を拒否する。
セッション単位の運用ログや、元資料が repository への収容を禁じる機密レポートは配布物に含めない。

今回の提出はコード変更まで。既存 Villa の常駐プロセス、旧URLの Tunnel 設定、main は変更しない。
配備時に Ex と Cc/Pf/Pe の変更を反映し、既存 Villa の直近差分を確認して移行先に同期する。
旧ホストの転送先を Ex の `/villa/` に切り替え、閲覧確認後に Ex 経由で旧 Villa を停止し
旧 catalog を無効化する。停止前は旧 Villa の公開を維持するため戻し先として利用できる。
配布物には `villa/` とViewer専用の `frontend/dist-dmz/` を含める。

## 検証

利用者の指示により単体・統合・起動・ブラウザ動作テストは実行しない。
型チェックとビルドは静的検証。全サービスの実機互換性・ログイン・WebSocket 接続の
成功を意味しない。配備・再起動・マージはこの PR 作成セッションでは行わない。
