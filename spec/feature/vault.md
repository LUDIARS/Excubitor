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

### 共有VaultとプロジェクトVault (2026-10-03 neco 指示)

Vault は共有とプロジェクト別を併設する。共有を全サービスに自動配布せず、それぞれの
Vault で使用する変数名をサービスへ明示的に紐付ける。サービスは最大1つのプロジェクトVaultを
参照し、共有とプロジェクトの両方に紐付いた同名はプロジェクトを優先する。
プロジェクトに紐付いた値が未登録なら、共有へ暗黙に戻さず起動を止める。
空文字は登録済みの環境変数として保存でき、未登録とは区別する。

既存の `vault.json` は共有Vaultとしてそのまま保持する。既存値・紐付けの削除や別名化はしない。
プロジェクト一覧は `vault-projects.json` (`version: 1`, `projects: [{id, name}]`)。
各プロジェクトの暗号化データは `vault-projects/<SHA-256(project ID)>/vault.json`。
共有と同じOS保護DEKを使い、暗号化AADは `JSON.stringify(['project', projectId, name])` として
プロジェクト間の暗号文付け替えを拒否する。共有のAADは従来の変数名で互換性を保つ。
拠点配布と控えにはサービス単位で解決した環境変数だけを渡す。

| データ | 分類 | 権威ソース | 保存先 | 保護 |
|---|---|---|---|---|
| プロジェクト一覧・紐付け | master | Exの管理者 | 上記ローカルJSON | 管理APIはloopback限定、値を含まない |
| プロジェクトの環境変数 | master | Exの管理者 (移行元はInfisical) | プロジェクト別vault.json | AES-256-GCM、DPAPI/0600保護DEK、ログと管理APIに平文を出さない |

Infisicalからは安定したproject IDをキーとして各プロジェクトへ保存し、表示名も取り込む。
共有Vaultへの自動取り込みは行わない。マッピングがあるサービスのみプロジェクトに紐付ける。
移行前にbackendとsupervisorをともに更新する。旧supervisorはプロジェクトVaultを解決しないため、
backendだけの更新では起動時に新しい値が反映されない。CLIは旧backendへの取り込みを拒否する。
共有にある旧データは残すため、プロジェクト値を共有へ自動逆移行するrollbackは行わない。

共有の `vault.json` (config.enc と同じディレクトリ、`EXCUBITOR_VAULT_DIR` で上書き)。

| キー | 内容 |
|---|---|
| `entries.<NAME>` | 暗号化した値 (AAD = 変数名。別の名前へ付け替えると復号できない) と更新時刻 |
| `bindings.<service>` | サービスが使う変数名 (「使用する環境変数」) |
| `source_peer_id` | 拠点: 取得元の本社ピア。本社は null |
| `cache.<service>` | 拠点: 本社から受け取った値の控え (AAD = `cache:<service>:<NAME>`) |

## 注入

通常起動・継続 secret 解決は Vault-only。Infisical identity/network、env-cli、.env 生成を使わない。
優先順位は共有ルート < global < topology < catalog env < 暗号化 runtime config < Vault。
Vault 内は明示的な共有 binding < プロジェクト binding。同名のプロジェクト値不足は共有へ戻さない。

1. ローカル binding がある場合は既存 Vault.envFor(code) で解決する。未登録値は起動を止める。
2. ローカル binding がなければ既存 source_peer_id → getPeer → fetchVaultEnv → 本社の
   vault-federation へ進む。署名・covered service 制限は従来どおり。本社の解決結果だけを
   cacheEnv で暗号化保存する。到達不能時は取得済み控えを使う。本社 404 は未紐付けとして扱う。
3. 取得元も binding もないサービスは secret なしとして扱える。ただし旧 infisical.inject=true が
   残るサービスで Vault 解決が空なら、未移行設定として明示失敗する。Infisical 取得には戻らない。
4. 必須 env は required_env / infisical.required_env / requires_secret を検証する。
   古い required_env は移行互換の宣言としてのみ読み、identity を要求しない。

### requires_secret の解決 (Vault-only)

消費サービス自身に紐付いた共有／プロジェクト Vault の値だけを使う。
source service は由来の説明であり、別サービスやプロジェクトを読む権限にはしない。
不足・空文字・空白だけの必須キーは名前付きで失敗し、Infisical fallback は行わない。
Vault 自体は空文字を保存・配布できるが、必須宣言されたキーは非空を要する。

preflight はサービスごとに注入 env を一度解決し、Vault エラーと必須 env 不足を ready に反映する。
チェック種別は vault。互換フィールド identityPresent / needsIdentity はともに false。
injectedKeys は topology 等を含む解決済み注入 env 全体の件数。

secret-agent も同じ resolveVaultEnv を使う。値返却は既存のトークン認証済み専用 API に限定する。
詳細は [secret-agent](secret-agent.md)。拠点の控えの失効・同期方針は今回変更しない。

## API

管理面 (loopback の本体のみ):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/vault` | 共有の名前・紐付け、`projects` 内のプロジェクト名・名前・紐付け、および取得元・控え。値は返さない |
| PUT | `/api/v1/vault/projects/:id` | `{ name }` プロジェクトVaultを登録・表示名変更 |
| PUT | `/api/v1/vault/entries/:name` | `{ value }` 登録 / 差し替え |
| DELETE | `/api/v1/vault/entries/:name` | 削除 (紐付けは残り未登録として表示) |
| PUT | `/api/v1/vault/bindings/:code` | `{ names }` 使用する環境変数 (空で外す) |
| PUT | `/api/v1/vault/source` | `{ peer_id }` 拠点の取得元 (null で本社) |
| POST | `/api/v1/vault/import/infisical/:code` | Infisicalのproject IDに対応するVaultへ移して紐付けに足す。同一プロジェクト内の同名異値は `conflicts` とし上書きしない |
| POST | `/api/v1/vault/import/infisical` | `{ dry_run?, environment? }` Infisical の全 project を一括で移す (下記)。名前と件数だけ返し、値は返さない |

公開面 (拠点間、相互登録の署名が必須): `POST /api/v1/federation/vault/env` `{ service }` → `{ env, missing }`。
渡した記録 (拠点・サービス・変数名) をログに残す。値は残さない。

WebUI: 「環境変数」タブ。

entries の PUT / DELETE と bindings の PUT は `?project=<id>` で登録済みプロジェクトを指定する。
未指定は共有。未知のIDは拒否する。WebUIは共有・プロジェクトの選択、登録、値の保存、紐付けに対応する。

### Infisical からの一括移行

Infisical は使わなくなるため、Excubitor の machine identity で参照できる全 project の値を Vault へ移す。

1. Infisical マッピングを持つサービス (Excubitor 設定優先 / catalog fallback) は、そのマッピング
   (project / environment / prefix / include / exclude) で取り込み、サービスの「使用する環境変数」に紐付ける。
2. どのサービスにも紐付かない project (`GET /api/v1/projects?type=secret-manager`) は値だけ取り込み、紐付けない
   (例: CF Tunnel ブローカーが読む `CF_API_TOKEN` / `CF_ACCOUNT_ID`)。environment は `environment` (既定 `dev`)。
   project に無く environment が 1 つだけならそれを使い、それ以外は skip して理由を返す。
3. 同一プロジェクト内の既存同名が別の値なら上書きせず `conflicts`。変数名に使えない名前は `invalid` として取り込まない。空文字は保持する。
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
