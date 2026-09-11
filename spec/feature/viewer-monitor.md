# [id: SPEC-VIEWER-MONITOR] Ex Monitorの閲覧入口

2026-09-11 neco指示: Ex自身のフロントビューもViewerの閲覧対象にする。

既存 `frontend/src/pages/Monitor.tsx` のproject/component表示を再利用する。Viewer内の独立entryからsnapshotを渡した場合に限り閲覧モードとなり、ローカルの管理Appは従来どおり動く。Viewerでの起動停止・設定編集について追加回答がないため、閲覧範囲として実装する。

## DMZ境界

管理プロセスが既存projects read modelをschemaで射影し、期限付きmanifestへ含める。公開項目はproject名、component名・code、runtime、state、port、git版情報、package版情報、health結果と確認時刻等の表示属性のみ。env、コマンド、ファイルパス、ログ、health詳細文字列、秘密情報の取得先は含めない。DMZは管理DB・管理APIへ接続しない。

`/viewer/apps/excubitor/` は別ビルドのMonitor HTMLを配信し、`/viewer/apps/excubitor/snapshot` だけが表示データを返す。この名前空間は任意のupstream転送に使わない。書き込みは405、未知のpathは404、期限切れ・snapshot不在は503。既存管理APIやWebSocketは公開しない。

## UXと資源寿命

起動操作群、ポートkill、ログ・詳細編集入口は閲覧モードに出さない。取得失敗時は古い状態を表示し続けず、エラーを表示する。10秒ごとの読込は前回完了後に予約し、unmount時にabortとtimer解放を行う。publisherは多重取得を避け、停止後の非同期完了でmanifestを再作成しない。

## 確認項目

既存ローカルMonitorの操作維持、Viewerメニュー選択、閲覧中に管理APIへ通信しないこと、manifestの秘密・path除外、期限切れ、書込みと未知route拒否、停止中publisherの再作成防止。テストはユーザーの明示指示がないため未実行。
