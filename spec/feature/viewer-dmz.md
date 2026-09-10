---
id: EX-VIEWER-DMZ
status: implemented-unverified
---

# 統合ビュー専用のDMZワーカー

## 価値・境界

利用者はCloudflare Accessで許可された統合ビューから各サービスを使う。
管理者用Ex Monitorとは別のプロセス・HTTP入口・フロントエンド成果物を使う。
Villaはこのビュー内の資料サービスであり、旧Villaホストからの転送は要件ではない。

利用者が承認した前提は、PC内のアクセスを信頼しloopback待受に限定すること、
Cloudflare Access設定が適切であること。DMZワーカーはAccess設定監査やJWT検証を
新設せず、CF管理APIトークンも要求しない。TunnelとAccessの設定は管理画面で行う。

## 不変条件

- EX-DMZ-01: Tunnelは `excubitor-viewer-dmz` のcatalogポートへ向ける。
  Ex管理フロント、MCP、設定・制御・秘密情報APIをワーカーにmountしない。
- EX-DMZ-02: Ex本体とDMZワーカーはいずれも127.0.0.1待受。
  本体の `/viewer`、`/villa` とViewer APIは404とし、WebSocket中継も外す。
- EX-DMZ-03: DMZフロントは独立entryと `frontend/dist-dmz` を使い、Monitorをbundleしない。
- EX-DMZ-04: ワーカーはEx DB、Infisical設定、サービス起動・停止モジュールをimportしない。
  Ex本体が生成する経路一覧だけを読み、公開対象の名前・URL・中継先を得る。
- EX-DMZ-05: 経路一覧は既存catalogのViewer許可とCorpus除外を適用して生成する。
  コマンド、環境変数、秘密設定、全catalogを渡さない。対象外の一覧も渡さない。
- EX-DMZ-06: 一覧の欠落・不正・期限切れはHTTP/SSE開始、VillaとWebSocket開始を拒否する。
  本体は10秒ごとに更新し、最後の成功から30秒で期限切れ。既存接続を即時失効させる契約ではない。

## 所有と寿命

管理プロセスは `data/viewer-manifest.json` の単独書き手。atomic renameで更新し、
終了時は更新timerを止めてファイルを除去する。更新失敗でも期限を延長しない。
ワーカーは起動時に専用フロント成果物を確認し、catalog由来のport未設定なら起動失敗。
マニフェスト未準備時はhealthも503とし、準備できれば再起動なしに読み取りを再開する。
ワーカー停止時はHTTP/SSEとupgrade socketを終了する。

## セキュリティ上の範囲

これはプロセス・提供API・bundleの分離であり、別OSユーザー・コンテナ・ファイアウォール
によるサンドボックスではない。PC内侵害は今回の要件外。公開対象サービスは引き続き
同じoriginと信頼範囲を共有し、個別サービスの認証・認可はそれぞれの責任。
各サービスの公開ホストのAccessはローカル中継時には通らないので、ExのAccess許可範囲に
含めてよいサービスだけをopt-inする。異なる利用者権限のサービスを無条件に統合しない。

## 配備と戻し方

この変更はPR提出まで。テスト・起動・再起動・main更新・Tunnel変更を含めない。
承認後、本体でbackendとfrontendをbuildしEx経由で反映する。Exのフロントbuildは
管理画面とDMZ画面を別々の出力先に生成する。新catalogの自動起動は既定で無効。
Ex本体のmanifest生成とDMZワーカーのhealthを確認後、TunnelをDMZ側へ設定する。
Cloudflare Accessの既存許可範囲を保持し、Ex管理ポートへTunnelを向けない。
旧Villaの停止は資料表示の確認後に別途実施する。
戻す際はTunnelを無効化または確認済みの旧設定に戻し、DMZをEx経由で停止する。
新しい公開入口をEx管理ポートへ向ける戻し方は禁止。

## 未実施の受入確認

管理API/MCPがDMZ経由で404、管理側のViewerが404、両待受がloopbackであること。
マニフェストがない・期限切れ・壊れた場合の503とWebSocket拒否、更新後の回復。
公開対象のHTTP/SSE/WebSocket、資料、assets、サービス固有ログインの動作。
Ex停止とワーカー停止の寿命管理、CF Access経由の入口確認。ユーザーの明示許可後にのみ行う。
