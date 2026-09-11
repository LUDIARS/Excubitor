# サービスデプロイ検知イベント

`service-startup` はサービスの起動時に解決した Git hash を SQLite の
`service_deployments` へサービスコードごとに1行で記録する。前回 hash が存在し、かつ今回と
異なるときだけ、Concordia の `/v1/events/service-deployed` へ `service.deployed` 相当の
`code`、前後 hash、version、startedAt、restartCount を POST する。

初回起動、同一 hash の再起動、Git hash を解決できないサービスは通知しない。通知の失敗は
起動結果を変更せず警告ログのみ残す。Concordia URL と timeout は既存 crash dispatch と同じ
`EXCUBITOR_CONCORDIA_URL` と `EXCUBITOR_CONCORDIA_TIMEOUT_MS` を使う。
