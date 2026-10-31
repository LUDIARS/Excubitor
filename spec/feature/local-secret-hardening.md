# ローカル秘密の保護 (master 鍵・agent token の分離)

- 参照: actio:8abb43ec-a0ff-4804-b479-e1e04cf6e0e7 (2026-10-29〜30 のセキュリティ点検の残り所見)
- 状態: Ex 側の実装済み・未検証 (テストは追加済み、実行は未実施)。各拠点への反映と移行の完了は運用手順で行う。

## 前提にする攻撃者

同じ PC 上で `127.0.0.1:17332` に TCP で届くが、ユーザの `%APPDATA%\Excubitor\` は読めないプロセス。
別の Windows アカウント (sandbox ユーザ・サービスアカウント)、loopback だけ許された sandbox 内のツールなど。
Windows では loopback の待ち受けを全ユーザが共有するので、loopback だけでは本人に限れない。
もう一つは、`excubitor.sqlite` や `config.enc` のコピー (バックアップ・移行データ) を読める者。

## master 鍵を KeyStore に置く {#SPEC-SECURITY-MASTER-KEY-STORE}

config.enc と remote_peers の機密列 (相手拠点の token・CF Access secret) を暗号化する master 鍵の扱い。

- 旧版は env `EXCUBITOR_MASTER_KEY` が無いと `excubitor:<hostname>:<user>` を鍵にしていた。画面やログから推測できるので、
  ファイルを持ち出せば復号できた。
- 新版は Vault の DEK と同じ KeyStore に、ランダムな 32 バイトの鍵を置く。win32 は DPAPI (CurrentUser) で保護した
  `master.key.dpapi`、それ以外は 0600 の `master.key`。置き場所は `%APPDATA%/Excubitor` (`EXCUBITOR_MASTER_KEY_DIR` で上書き可)。
  config-store / secret-box は同期 API なので、同期の KeyStore (`src/secrets/master-key-store.ts`) で読み、プロセスごとに
  1 回だけ読んでキャッシュする。backend と supervisor が同時に初回生成しても鍵が 2 本にならないよう、排他作成 (`wx`) にする。
- env `EXCUBITOR_MASTER_KEY` は従来どおり最優先。この場合は管理者が鍵を選んでいるので、旧鍵による移行はしない。
- 移行 (旧データを壊さない):
  - 復号は現在の鍵 → 旧鍵の順に試す (`openWithMasterKeys`)。旧鍵で開けたものは新しい鍵で暗号化し直す。
  - config.enc: 読み込み時に、新しい鍵で暗号化した blob を作り、開けることを確かめてから一時ファイル → rename で置き換える。
    失敗したら旧ファイルを残し、次の読み込みで再試行する。書き込みは常にこの手順にする。
  - remote_peers: backend 起動時に `resealLegacyPeerSecrets()` が、旧鍵の blob と平文のまま残った値を 1 行ずつ暗号化し直す。
    どの鍵でも開けない値には触れない。
  - KeyStore の鍵が読めない (DPAPI の失敗など) ときは旧鍵に落とさない。config.enc は読み取り専用扱いにし、
    空の設定で上書きしない。
- 旧鍵で作られたバックアップは旧鍵で開けたままになる。必要なら移行後にバックアップを作り直す。
- テストは実拠点の設定に触れない。vitest の setup (`src/test-support/isolate-local-secrets.ts`) が `APPDATA` /
  `XDG_CONFIG_HOME` / `EXCUBITOR_CONFIG_PATH` / `EXCUBITOR_MASTER_KEY_DIR` / token の置き場所を一時フォルダへ強制し
  (継承した値も上書き)、`EXCUBITOR_MASTER_KEY` を外す。さらに実際の `%APPDATA%/Excubitor` への書き込み・rename・削除を
  失敗させるガード (`real-config-guard.ts`) を入れる。旧版の setup は鍵の置き場所だけを逃がしていたため、
  一時鍵で本物の config.enc を「移行」して本番が起動できなくなった (2026-10-30)。

## agent token の用途分離 {#SPEC-SECURITY-AGENT-TOKEN-SPLIT}

旧版は 1 本の agent token (`secret-agent.token` / env `EXCUBITOR_AGENT_TOKEN`) を、次の 3 つの用途に使っていた。

1. secret-agent (`POST /api/v1/secrets/resolve`) の認証。service は呼び出し側の自己申告で、全サービス共通だった。
2. 拠点間 (legacy-monitor) の Bearer と HMAC 署名鍵。相手拠点の remote_peers にも保存される。
3. `GET /api/v1/federation/self` の応答。loopback に届く誰にでも返していた。

このため loopback に届くだけのプロセスが、全サービスの Vault 値を取り出せた。相手拠点の DB から token が漏れた場合も同じだった。

### 新しい形

| 用途 | token | 出所 |
|---|---|---|
| secret-agent | サービス token `exsa1.<code>.<mac>` (mac = HMAC(master 鍵由来の subkey, code)) | Ex が起動するサービスには env `EXCUBITOR_AGENT_TOKEN` で渡す (`process/inject.ts`)。bootstrap の setup / export / import スクリプトにも同じく渡す。Ex の外で起動するものは `npm run agent-token -- service <code>` |
| 拠点間 (legacy-monitor) | mesh token | env `EXCUBITOR_MESH_TOKEN` → `mesh.token` (`EXCUBITOR_MESH_TOKEN_PATH`)。初回は旧 token の値で作る |
| 旧共有 token | `secret-agent.token` | 移行期間の互換としてだけ secret-agent で受ける |

- サービス token で resolve できるのは token のサービスだけ。body の `service` と違えば 403 `service_mismatch`。
  既存のクライアント (Actio `src/config/excubitor/endpoint.ts`、Tirocinium) は env `EXCUBITOR_AGENT_TOKEN` を token ファイルより先に
  読むので、Ex 経由で起動し直せば改修なしでサービス token に移る。
- Ex 自身 (`excubitor` / `excubitor-*` / project `Ex`) にはサービス token を渡さない。env の値がサービス token の形なら、
  Ex はそれを旧共有 token として扱わない。
- `GET /api/v1/federation/self` は token を返さない。代わりに `token_command` (`npm run agent-token -- mesh`) を返す。
  管理画面はこのコマンドを表示する。token を取り出せるのは、ファイル ACL と KeyStore で守られた端末上の操作だけになる。
- 管理者コマンド `npm run agent-token -- mesh | rotate-mesh | service <code>` (`src/secrets/agent-token-cli.ts`)。

### 移行手順 (既存拠点)

1. 新しい版へ更新して Ex を再起動する。この時点の挙動は変わらない。
   - `mesh.token` が旧 token の値で作られるので、相手拠点に登録済みのピアはそのまま通る。
   - 旧共有 token は secret-agent で引き続き受ける (起動ログに警告が出る)。
2. Ex 経由でサービスを再起動し、各サービスがサービス token で resolve することを確かめる。
   旧共有 token で resolve したサービスは、サービスごとに 1 回 warn ログが出る (`secret-agent resolved with the legacy shared token`)。
   Ex の外で起動するサービスには `npm run agent-token -- service <code>` の値を env `EXCUBITOR_AGENT_TOKEN` に設定する。
3. warn が出なくなったら、その拠点の env に `EXCUBITOR_SECRET_AGENT_LEGACY_TOKEN=reject` を設定して Ex を再起動する。
   これで旧共有 token と mesh token (まだ旧 token と同じ値) は secret-agent で受けなくなる。
4. 拠点間 token を旧 token の値から切り離す。`npm run agent-token -- rotate-mesh` で入れ替えて Ex を再起動し、
   相手拠点のピア登録 (この拠点の token) を新しい値に更新する。両方そろうまで、その拠点への legacy-monitor 監視は止まる。
5. cr-v1 へ移行した拠点は mesh token を使わない (下の残課題)。

旧共有 token の受け入れは、手順 3 を管理者が行うまで続く (期限は設けない)。既定値を `reject` に変える時期は別途決める。

### 残課題

- cr-v1 へ移行したピアでも remote_peers は相手の token を保存し続けている。cr-v1 の peer では token を保存しないようにする変更は未着手。
- サービス token は master 鍵から導出するので、master 鍵を変えると全サービスの token が変わる (Ex 経由で起動し直せば追従する)。
  サービス単位で失効させる仕組みは無い。
