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
| `overrides.<service>` | 拠点: 本社の値より優先する変数名 (拠点の上書き)。値は `entries` に置く。本社へは送らない |
| `source_peer_id` | 拠点: 取得元の本社ピア。本社は null |
| `cache.<service>` | 拠点: 本社から受け取った値の控え (AAD = `cache:<service>:<NAME>`) |

## 注入

通常起動・継続 secret 解決は Vault-only。Infisical identity/network、env-cli、.env 生成を使わない。
優先順位は共有ルート < global < topology < catalog env < 暗号化 runtime config < Vault。
Vault 内は明示的な共有 binding < プロジェクト binding。同名のプロジェクト値不足は共有へ戻さない。

1. ローカル binding がある場合は既存 Vault.envFor(code) で解決する。未登録値は起動を止める。
2. ローカル binding がなければ既存 source_peer_id → getPeer → fetchVaultEnv → 本社の
   vault-federation へ進む。署名・covered service 制限は従来どおり。本社の解決結果だけを
   cacheEnv で暗号化保存する。一時障害時の控えの扱いは下の「拠点の控えによる起動」に従う。本社 404 は未紐付けとして扱う。
3. 取得元も binding もないサービスは secret なしとして扱える。ただし旧 infisical.inject=true が
   残るサービスで Vault 解決が空なら、未移行設定として明示失敗する。Infisical 取得には戻らない。
4. 必須 env は required_env / infisical.required_env / requires_secret を検証する。
   古い required_env は移行互換の宣言としてのみ読み、identity を要求しない。

### 拠点の上書き (site override) {#SPEC-EX-VAULT-SITE-OVERRIDE}

2026-10-11 neco 指示 (Actio `actio:316e1a81-606d-4cb3-806e-0f3935204365`)。AWS 拠点の Cernere は本社と
同じ OAuth アプリ (秘密) を使い、`DATABASE_URL` / `REDIS_URL` / `FRONTEND_URL` / `*_REDIRECT_URI` /
`CERNERE_PUBLIC_URL` だけを拠点固有にする。Vault は catalog env より優先されるため catalog では上書きできない。

- 拠点の `vault.json` の `overrides.<service>` に変数名を並べ、値は共有 `entries` に登録する。拠点ローカルで本社へは送らない。
- 適用は「ローカル binding が無く `source_peer_id` がある」場合だけ。本社取得値 (取得失敗時は控え、
  取得元ピアが未登録・無効なら控え) に上書きの値を後勝ちで重ねる。本社 404 (未紐付け) なら上書きの値だけで解決する。
- 上書きの名前で値が未登録なら、本社の値へ黙って戻さず名前付きで起動を止める (本社へ問い合わせる前に検査する)。
  本社側で未登録 (`missing`) の名前でも、拠点が上書きしていれば止めない。
- 控え (`cache`) には本社の値だけを保存し、上書きの値は混ぜない。
- ローカル binding がある場合 (全値ローカル) と、上書きの無いサービスの挙動は変えない。取得元の無い本社では上書きは使わない。
- 管理 API・画面・ログは名前だけを扱い、値を出さない。

### requires_secret の解決 (Vault-only)

消費サービス自身に紐付いた共有／プロジェクト Vault の値だけを使う。
source service は由来の説明であり、別サービスやプロジェクトを読む権限にはしない。
不足・空文字・空白だけの必須キーは名前付きで失敗し、Infisical fallback は行わない。
Vault 自体は空文字を保存・配布できるが、必須宣言されたキーは非空を要する。

preflight はサービスごとに注入 env を一度解決し、Vault エラーと必須 env 不足を ready に反映する。
チェック種別は vault。互換フィールド identityPresent / needsIdentity はともに false。
injectedKeys は topology 等を含む解決済み注入 env 全体の件数。

secret-agent も同じ resolveVaultEnv を使う。値返却は既存のトークン認証済み専用 API に限定する。
詳細は [secret-agent](secret-agent.md)。

### 拠点の控えによる起動 {#SPEC-VAULT-CACHE-FALLBACK}

参照: actio:b4c5bde3-fcda-47da-b528-6f9c0857ebb7 (拠点 mesh Cr 認可移行で監視・Vault・運用を止めない)

拠点が本社から取得するときの失敗を、判断の純関数 `src/vault/vault-fallback.ts` で 4 つに分類する。

| 分類 | 条件 | 扱い |
|---|---|---|
| 一時障害 (transient) | 応答なし・timeout・5xx・408/429、送信側の Cr token 発行失敗、mesh 認証の未配備 (移行中の legacy-monitor を含む) | 最後に正常取得した控えで起動する。ログ (warn) と Discord 通知 (設定時) を出す |
| 失効・拒否 (revoked) | 401 / 403、管理者がこの peer の mesh policy を外した (`peer_auth_not_configured`) | 控えを使わず、控えも破棄して起動を止める。ログと通知を出す |
| 未紐付け (unbound) | 404 | Vault を使わないサービスとして空で起動する (従来どおり) |
| 想定外 (rejected) | その他の 4xx、応答本文の形式不正 | 控えを使わずに起動を止める。控えは消さない |

- 控えが無い、または復号できない一時障害は起動を止める (部分的な値で起動しない)。
- 秘匿性の高いサービスは catalog の `vault_cache_fallback: false` で控えによる起動を禁止できる。この場合は
  正常取得時にも控えを保存せず、既存の控えを消し、一時障害で起動を止めて通知する。省略時は true。
- 控えの使用・破棄はどちらも新規の解決だけに効く。すでに動いているプロセスの env は回収しない。
- 通知文には値も鍵名も載せない (サービスコード・事象・控えの取得時刻のみ)。
- 判断は純関数、控えの読み書きは `vault-inject.ts`、ログと通知は `vault-fallback-notify.ts` に分ける。

## API

管理面 (loopback の本体のみ):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/vault` | 共有の名前・紐付け、`projects` 内のプロジェクト名・名前・紐付け、および取得元・控え。値は返さない |
| PUT | `/api/v1/vault/projects/:id` | `{ name }` プロジェクトVaultを登録・表示名変更 |
| PUT | `/api/v1/vault/entries/:name` | `{ value }` 登録 / 差し替え |
| DELETE | `/api/v1/vault/entries/:name` | 削除 (紐付けは残り未登録として表示) |
| PUT | `/api/v1/vault/bindings/:code` | `{ names }` 使用する環境変数 (空で外す) |
| PUT | `/api/v1/vault/overrides/:code` | `{ names }` 拠点の上書き (空で外す)。共有Vaultのみ。`GET /api/v1/vault` の `overrides` に名前と登録有無を返す |
| PUT | `/api/v1/vault/source` | `{ peer_id }` 拠点の取得元 (null で本社) |

公開面 (拠点間、相互登録の署名が必須): `POST /api/v1/federation/vault/env` `{ service }` → `{ env, missing }`。
渡した記録 (拠点・サービス・変数名) をログに残す。値は残さない。

WebUI: 「環境変数」タブ。

entries の PUT / DELETE と bindings の PUT は `?project=<id>` で登録済みプロジェクトを指定する。
未指定は共有。未知のIDは拒否する。WebUIは共有・プロジェクトの選択、登録、値の保存、紐付けに対応する。

### 廃止済みの外部サービス連携

Infisical の取得・移行 API とスクリプトは撤去した。環境変数タブで共有またはプロジェクトの Vault を選択し、値と使用サービスの紐付けを管理する。既存の Vault 値と紐付けは変更しない。旧 catalog/config の必須条件は読み取り専用で保持し、Vault 未移行を匿名・設定なしとして起動しない。
