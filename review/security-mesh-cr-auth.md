## 実装内容

共有peer鍵から別拠点になりすませる構成と、healthのcovered自己申告によるVault配布を制限します。Cr拠点/workload用adapter、宛先とtokenまで束縛したEd25519要求署名、SQLiteによるnonce永続化、操作/資源/秘密キーごとのgrant検査を追加しました。

peerごとにdisabled・legacy-monitor・cr-v1を固定し、旧方式はhealth/nodeのみ許可します。Cr失敗時の旧認証fallbackや、Vault認可不能時の古いcache使用は拒否します。待機operationは実行直前に再認可し、失効・期限切れ・再起動で許可を失った依頼を実行しません。mesh bundleは管理者が受信側で承認したSHA256に一致するもののみ取り込みます。HTTPS listener設定とloopback管理APIのブラウザ由来Host/Origin/JSON検査を追加しました。

既存peer store、operation runner、Vault、Node cryptoを再利用します。署名検証者に秘密鍵を配るHMACとcoverageベース認可は新方式に採用しません。契約観測は既存Lapilli submoduleのlog-weaverを再利用します。詳細設計はspec/feature/security-mesh-cr-auth.md、関連参照はactio:7a9649fb-f582-4082-b841-922ba798139bです。

## 受け入れ条件

C-14〜C-18でworkload claims、action/resource、秘密キー、要求署名、artifact digestの契約を定義・注入しました。権限越境、なりすまし、改ざん、期限切れ、再送、失効、nonce再起動保持、旧方式への降格拒否を回帰テストとして追加・更新しています。

型チェックとgit diff --checkは成功しました。指示によりテスト、サービス起動、再起動、デプロイは実行していません。Augur集計の新規5契約はすべてnot-calledで未充足です。既存C-1〜C-4にpredicate module不在のlint指摘があり、今回の変更範囲外です。

## 移行前提・残件

このPRはEx側の実装段階で、全体完了ではありません。Cr現行project PASETOにworkload粒度はないため、本設計のHTTPS token/introspection wire contractをCr実装と突合する必要があります。Cc側AI-spawn/相談セッション制限とCr主体登録はこのworktree外です。監視専用に残した旧共有鍵のなりすましリスクは、全peer移行・旧鍵撤去まで残ります。

EXCUBITOR_MESH_SECURITY_FILE未配備ではmesh認証を拒否します。cr-v1にはsite固有credentials/Ed25519鍵、Cr endpoint、相互TLS接続（TLS証明書の通常検証）、grant、承認bundle digestの管理者配備が必要です。mTLSを実装した意味ではありません。live鍵生成/rotation、登録、CF変更、稼働設定変更は行っていません。短いtoken期限により長時間待機したremote operationは再依頼が必要です。

loopbackのHost/Origin検査はブラウザ経路の対策です。SSRF/悪性ローカルプロセスに対する管理API資格情報の導入は残件です。異なるportの開発UI Originも既定で許可しません。ログはこのworktree内で取得し、main側problem logは編集許可外のため未追記です。

merge・auto-merge・push・本番反映を依頼するPRではありません。
