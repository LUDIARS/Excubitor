# secret-agent — Vault-only secret resolve

POST /api/v1/secrets/resolve は既存の loopback + agent token 認証を維持する。
要求は { service, keys? }。プロジェクト選択、任意 Vault 読み出し、値を返す管理 API は追加しない。

- resolveVaultEnv(service) を再利用し、そのサービスに明示 binding された値のみ返す。
- keys 未指定／空配列は binding 全件、指定ありは部分集合。binding 外のキーを一つでも
  指定すると全体を 403 keys_not_bound で拒否し、部分成功にはしない。
- binding の解決結果が空なら 404 no_mapping。Vault 解決失敗は 502 fetch_failed。
  エラーは一般化し、保存先・通信相手のレスポンス本文・秘密値を公開しない。
- 正常応答: { secrets: { ... }, project_id: null, environment: null, source: "vault" }。
  Vault は environment を区別せず、共有とプロジェクトの合成結果を返すため、旧 Infisical
  マッピングを取得元として偽装しない。prefix/include/exclude は実行時に適用し直さず、
  移行時に保存・binding されたキー名を使う。Infisical identity/network/TTL cache は使わない。

## クライアント移行差分

- Actio src/config/excubitor/secret-agent-client.ts は project_id/environment を旧設定と厳密照合する。
  現状は source_mismatch となるため、Vault source と service/keys の契約へ移行が必要。
  src/config/secret-source.ts の Infisical project/environment 前提も後続で変更する。
- Tirocinium packages/secrets/src/client.ts は secrets の文字列 map のみ検証するため正常応答は互換。
  403 は現状 fetch_failed に分類される。必要なら keys_not_bound のエラー分類を追加する。
- 全サービスが共有 agent token を使う既存認証は維持し、service ごとの独立認証は追加しない。
  本 API はトークン所有者の指定 service に対する既存 binding を上限とする。

本社取得・暗号化控えは [Vault](vault.md) の既存経路を共用。一般管理面には値を返さない。
