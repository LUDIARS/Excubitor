# Viewer 対象候補一覧

調査日: 2026-09-09。対象リストアップのみであり、掲載設定は変更していない。

## 調査範囲と判定

workspace 直下の本体 git リポジトリの `excubitor.catalog.yaml` を確認し、linked worktree・複製作業ディレクトリを候補の重複として数えない。補足として Castra の `scripts/excubitor.catalog.yaml` を確認。catalog にない画面は自動推測で追加しない。UI ファイルの存在と主要 manifest、除外に関係する source/spec を静的に照合した。HTTP・ログイン・埋め込みの動作確認は未実施。

確認した候補の catalog に `viewer.enabled: true` はなかった。以下は統一・掲載の候補であり、現在利用可能な Viewer メニューの一覧ではない。DB の実効 Corpus 設定は別途掲載前に照合が必要。

## 先行する候補

| サービス / catalog code | フロントエンド根拠 | 必要事項 |
|---|---|---|
| Concordia / concordia | `Concordia/web/package.json`、React/Vite/React Router | 共通 router/API adapter。既存 basename 対応は利用する |
| Praeforma / praeforma | `Praeforma/web/package.json`、React/Vite/router | 共通 router/API adapter。catalog frontend_url あり |
| Peregrinatio / peregrinatio | `Peregrinatio/apps/web/`、React/Vite/React Router/PWA | 共通 adapter と Viewer 内 SW 登録停止。standalone PWA 維持 |
| Villa / villa | Ex `villa/routes.json` と静的 HTML | Ex 内蔵資料。旧プロセスを proxy しない。資料除外を維持 |

## 条件付き候補

| サービス / catalog code | 根拠・保留理由 |
|---|---|
| Genius / genius | `Genius/ui/index.html`。静的 UI を共通 ESM へ。公開・認証境界の照合が必要 |
| Discutere / discutere | `Discutere/frontend/` に生成物 dist を確認したが、同ディレクトリのソース manifest は未確認。catalog は backend 登録。現行 UI の所有元・配信経路・リアルタイム接続を確定するまで保留 |
| Pagus / pagus-client | `Pagus/packages/client/package.json` は Vite/Pixi.js。pagus backend の接続を共通 URL 契約へ |
| Tirocinium / tirocinium-desktop | `Tirocinium/apps/desktop/package.json` は React/Vite/Router。デスクトップ機能依存とブラウザで利用可能な範囲を確認 |
| Voluptas / volputas | catalog cwd は `Voluptas/player-profile-server`。frontend あり。認証 callback が直接 origin を指定するため先に整合確認。Volputas 側の同じ code は別サービスとして重複登録しない |
| MakaiNui WebAR / makainui-web | `MakaiNuiPictor/web/` と catalog の静的配信定義。独自の名前・合言葉ゲートを維持し、カメラ等の埋め込み要件を確認。独立公開が必要なら除外 |

## セキュリティ・ユーザ指定による除外

| サービス / 範囲 | 根拠 |
|---|---|
| Actio / actio, actio-web | ユーザ指定のループバック必須 |
| Interpres / 関連サービス | ユーザ指定。native/local-app 部分も対象外 |
| Ludellus / capture, web, server, realtime 等 | ユーザ指定。派生を含め対象外 |
| Manus / manus | Ex `src/viewer/catalog.ts` のローカル入力サービス除外 |
| GLAB / glab、Corpus およびその派生 | ユーザ指定。GLAB catalog の Corpus 利用宣言。uses_corpus、依存、CORPUS_*、実効設定を含め除外 |
| Quaestor / quaestor, quaestor-web | `src/shared/local-request.ts`、config/mail-intake/memoria API が直接ループバックを要求。公開共有ページも個別保護あり |
| Sartor / sartor | `src/web/server.ts`: frame-ancestors none、X-Frame-Options DENY |
| Vultus / vultus | `server/src/api/handlers/web.ts`: frame-ancestors none、X-Frame-Options DENY。analyzer は画面ではない |
| Aedilis / aedilis | `spec/setup/webauthn-rp-id.md`: PWA の origin が passkey 検証契約の基準 |
| Ostiarius / ostiarius | WebAuthn RP ID と PWA origin が必須。face-sidecar は画面ではない |
| Cernere / cernere-frontend | Aedilis/Ostiarius と WebAuthn origin 整合に関与。今回の自動統合から除外し、認証面を別 origin のまま維持 |
| Calliope / service-map | `src/routes/servicemap.ts`: frame-ancestors none。この画面を含む一括 opt-in はしない。別画面の可否は別途確認 |

明示的な保護がある経路を「Ex 経由なら通る」よう書き換えない。上表の静的調査で見つからなかった保護について、安全性確認済みとは扱わない。

## Web 画面の対象に数えないもの

Anatomia、Augur、Curare、Histrio、Memoria、Revisor は今回調べた catalog が backend/worker 等であり、画面入口を確定していない。健康確認 URL があることだけで Viewer に掲載しない。Concordia の control/cost、Imperativus の STT/MQTT、各 analyzer/sidecar、infra、native、Unity editor、Pictor/Figmentum の検証用プロセスも同様。

Castra dw は設定 UI だが、同一 code/port と管理権限の確認が必要であり今回の候補に追加しない。KonbiniDominant の catalog は services が配列でないため、この一覧のサービス列挙には使っていない。catalog 不整合の修正は今回のリストアップに含めない。

## 反映前の条件

候補ごとに所有リポ、実際の配信入口、実効 Corpus 設定、認証/埋め込み制約を確認してから、所有 catalog に掲載許可を定義する。今回はリストアップまでという指示に従い、許可設定・起動・配備は実施しない。
