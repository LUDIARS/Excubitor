# Vault — 本社で持つ暗号化した環境変数 (Infisical の置き換え)

2026-09-30 neco 指示。Infisical は重いわりに担う仕事が小さく、Ex の中継で環境変数の経路が複雑化していた。
本社の Excubitor を基準に、暗号化 Config の方式で「使用する環境変数」をまとめて持つ。

## 決定事項

- 値の鍵 (DEK、AES-256-GCM) は OS 側に保管する。Windows は DPAPI (CurrentUser)、それ以外は 0600 ファイル
  (supervisor は LaunchDaemon / systemd でログイン無しに動くため Keychain / libsecret は使えない)。
  パスキー解錠は Ex 再起動のたびに人手が要るため採らない。
- 「AI が読めない」は保証しない。同じ OS ユーザの権限で復号できる。値の性質上リスクは小さいとして許容 (neco)。
  そのうえで、値を返す管理 API・画面は作らない。平文を使うのはサービス起動時の env 注入と、本社から拠点への配布だけ。
- 拠点へは本社から配る。拠点は取得元 (本社のピア) を設定し、起動時に本社へ署名付きで取りに行く。
  本社は、その拠点が担保しているサービス (巡回キャッシュの covered) の分しか返さない。
  拠点は受け取った値を自分の DEK で暗号化して控え、本社に届かないときだけ使う (本社停止で拠点の自動復旧を止めない)。

## データ

`vault.json` (config.enc と同じディレクトリ、`EXCUBITOR_VAULT_DIR` で上書き)。

| キー | 内容 |
|---|---|
| `entries.<NAME>` | 暗号化した値 (AAD = 変数名。別の名前へ付け替えると復号できない) と更新時刻 |
| `bindings.<service>` | サービスが使う変数名 (「使用する環境変数」) |
| `source_peer_id` | 拠点: 取得元の本社ピア。本社は null |
| `cache.<service>` | 拠点: 本社から受け取った値の控え (AAD = `cache:<service>:<NAME>`) |

## 注入

`resolveInjectEnv` の最上位 (Infisical・requires_secret より優先)。

1. 自分の Vault にそのサービスの紐付けがある (本社) → 自分の値。紐付けた値が未登録なら起動を止める。
2. 取得元が設定されている (拠点) → 本社から受け取り、控えを更新。本社に届かなければ控え。控えも無ければ空で進め、
   必須の変数は startup-env の検査が名前付きで止める。本社で紐付けが無い (404) なら Vault を使わないサービス。
3. どちらでもない → 何もしない。

### requires_secret の解決順 (Vault 優先)

catalog の `requires_secret` (他サービスから名前付きで借りるキー) は、上の手順で得たそのサービスの Vault の値を先に見る
(`src/process/requires-secret-plan.ts`、`resolveRequiresSecretEnv`)。

1. 要求キーのうち Vault の紐付けで値が得られるものは Vault から満たし、Infisical には取りに行かない。
2. 全キーが Vault で揃えば machine identity も Infisical 呼び出しも不要 (Infisical が止まっていても起動できる)。
3. 足りないキーがある場合だけ、その分を従来どおり source service の Infisical project から取る。identity が無い・取得に
   失敗した場合は従来どおり起動を止める。
4. Vault で満たしたことはキー名だけをログに残す (値は出さない)。

preflight の `requires_secret` チェックも同じ規則で、Vault で揃うサービスは identity が無くても失敗にせず、
`needsIdentity` にも数えない。

## API

管理面 (loopback の本体のみ):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/vault` | 名前・更新日時・使うサービス・紐付け (未登録の有無)・取得元・控え。値は返さない |
| PUT | `/api/v1/vault/entries/:name` | `{ value }` 登録 / 差し替え |
| DELETE | `/api/v1/vault/entries/:name` | 削除 (紐付けは残り未登録として表示) |
| PUT | `/api/v1/vault/bindings/:code` | `{ names }` 使用する環境変数 (空で外す) |
| PUT | `/api/v1/vault/source` | `{ peer_id }` 拠点の取得元 (null で本社) |
| POST | `/api/v1/vault/import/infisical/:code` | Infisical の値を Vault に移して紐付けに足す。名前空間は 1 つなので、既にある同名が別の値なら上書きも紐付けもせず `conflicts` で返す (同じ値は `unchanged` として紐付ける) |
| POST | `/api/v1/vault/import/infisical` | `{ dry_run?, environment? }` Infisical の全 project を一括で移す (下記)。名前と件数だけ返し、値は返さない |

公開面 (拠点間、相互登録の署名が必須): `POST /api/v1/federation/vault/env` `{ service }` → `{ env, missing }`。
渡した記録 (拠点・サービス・変数名) をログに残す。値は残さない。

WebUI: 「環境変数」タブ。

### Infisical からの一括移行

Infisical は使わなくなるため、Excubitor の machine identity で参照できる全 project の値を Vault へ移す。

1. Infisical マッピングを持つサービス (Excubitor 設定優先 / catalog fallback) は、そのマッピング
   (project / environment / prefix / include / exclude) で取り込み、サービスの「使用する環境変数」に紐付ける。
2. どのサービスにも紐付かない project (`GET /api/v1/projects?type=secret-manager`) は値だけ取り込み、紐付けない
   (例: CF Tunnel ブローカーが読む `CF_API_TOKEN` / `CF_ACCOUNT_ID`)。environment は `environment` (既定 `dev`)。
   project に無く environment が 1 つだけならそれを使い、それ以外は skip して理由を返す。
3. 既にある同名が別の値なら上書きせず `conflicts`。変数名に使えない名前と空の値は `invalid` として取り込まない。
   1 件の失敗は `error` に入れて残りを続ける。`dry_run` は分類だけ返して Vault を変更しない。

実行 (本社の Excubitor で、人が実行する):

```bash
node scripts/vault-import-infisical.mjs --url http://127.0.0.1:17332/ --dry-run   # 何が入るかだけ見る
node scripts/vault-import-infisical.mjs --url http://127.0.0.1:17332/             # 登録する
```

スクリプトは loopback の Excubitor だけを呼び、資格情報を持たず値も表示しない。POST は再送しない。

2026-10-01: 本社で Infisical の値を取り込み済み (cernere 47 / ostiarius 5 / volputas 6 / discutere 2、いずれも同じ project・環境で同名は同値)。
ostiarius / volputas には requires_secret で借りていた `EXCUBITOR_CERNERE_CLIENT_ID` / `_SECRET` も紐付けた。
ludellus-web は Infisical 設定がコメントアウト、volputas-haster は disabled のため対象外。
