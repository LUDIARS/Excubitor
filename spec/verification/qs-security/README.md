# qs の非破壊セキュリティ更新

関連タスク: `actio:a5a1c15f-bfa4-4f49-8589-e5fe030e191b`

## 実装内容

ルートの lockfile にある qs 6.16.0 を 6.16.2 に更新する。変更する値は版、公開 npm tarball URL、integrity のみ。
body-parser 2.3.0 の要求 `^6.15.2` と express 5.2.1 の要求 `^6.14.0` はどちらも 6.16.2 を含む。
公開 registry の 6.16.2 は従来と同じ依存、Node 要求、BSD-3-Clause ライセンスを持つ。
親の更新、overrides、直接依存の追加は不要。

再利用: 既存の親依存と log-weaver の契約ランタイムを利用する。
qs は親の query parser として必要であり、標準 API や自作への置換は親の互換性を変えるため採用しない。
本変更によるアプリケーションの通信追加はない。検証時だけ公開 npm registry の固定版メタデータと tarball を GET する。
認証情報、私有ソース、環境変数は送信せず、取得したパッケージもライフサイクルスクリプトも実行しない。

## 受け入れ条件 {#SPEC-EX-QS-SECURITY-LOCK}

C-28 verifyQsLock(before, after, release): qs 6.16.2 の配布情報と親要求を確認し、他のロック項目を変更しない

検証コードは既存の `test-environment` ドメインに属し、プログラム層は `infrastructure` とする。
`verifyQsLock` は本節を `@spec` で参照する。PR #3600 の対象ドメイン未設定を解消するための関連付けであり、
依存更新の範囲・判定条件・アプリケーション動作は変更しない。

## 検証

`augur plan` の現状把握方針に対応し、更新前のローカル基点 `444dcd0` と更新後を比較する。
`node spec/verification/qs-security/verify.test.mjs` で SHA-512 と契約を検証し、旧版・不正 integrity・親要求の変更・無関係な版更新を拒否する。
この検証は公開 registry へ接続する。サービス操作は行わない。

契約と述語は lockfile 更新前に作成した。ルートの既存 `augur.contracts.json` は C-14〜C-18 の ID が重複し注入できないため、
本ディレクトリを今回の検証専用 Augur project とする。既存契約の変更は対象外。

```powershell
node E:/Document/Ars/Augur/bin/augur.mjs inject apply --project spec/verification/qs-security --rule contract-wrap --diff-base main
$env:VESTIGIUM_LOGS_DIR = "$PWD/spec/verification/qs-security/logs"
node spec/verification/qs-security/verify.test.mjs
node E:/Document/Ars/Augur/bin/augur.mjs contracts report --project spec/verification/qs-security --acceptance --json --since <委託開始のISO時刻>
```

実施結果: 配布物 SHA-512、契約 1 件、負例 4 件が成功。契約違反 0 件。
アプリケーション全体のテスト、ビルド、起動、再起動は依頼範囲外のため未実施。
