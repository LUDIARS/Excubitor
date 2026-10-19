# Ex mesh の拠点認証・認可

- ID: SPEC-SECURITY-MESH-CR-AUTH
- Task: actio:7a9649fb-f582-4082-b841-922ba798139b
- 状態: Ex 側実装仕様。Cr adapter の相互接続と運用移行は未実施。

## 境界

直接 mesh を維持する。Cr は拠点×workload の独立した主体、宛先、操作、資源、秘密キーの grant と失効の正本。Ex は要求ごとの認証・認可を強制する。Ex/Cc 共通資格情報や project 全体の資格情報は使用しない。

設定は管理者が配備する `EXCUBITOR_MESH_SECURITY_FILE` の JSON。peer UUID ごとに `disabled` / `legacy-monitor` / `cr-v1` を固定する。未設定の peer は拒否する (この設定ファイル自体が未配備の移行期間だけは、下の「移行用 legacy-monitor」を明示的に有効にした場合に限り、登録済み peer を legacy-monitor として扱う)。legacy は health/node の読み取りだけで、Vault、bundle、operation は拒否する。Cr の失敗は legacy に戻さない。既存 remote_peers は接続・表示に再利用し、新認証の秘密鍵を peer DB に保存しない。

Cr の現行 project PASETO を workload token として流用しない。Ex の adapter は HTTPS の token/introspection endpoint を明示設定し、redirect を禁止する。受信側は自身の workload credentials で Cr に毎回 introspection を行い、`active:true` と厳密な workload claims を検査する。認可結果はキャッシュしない。Cr 障害時は mesh 要求を拒否し、既存のローカルサービスを停止しない。これは公開鍵による offline 検証とは別の、オンライン失効確認方式である。Cr 側 endpoint の実装・登録が揃うまで `cr-v1` を稼働有効化しない。

## adapter wire contract（Cr 側との突合が移行条件）

- token: POST JSON `{client_id, client_secret, audience, action, resource}` → `{access_token}`。Cr は要求値をそのまま grant にせず、DB の主体・宛先 grant との積集合を発行する。
- introspection: POST JSON `{client_id, client_secret, token, audience}` → `{active:true, claims}`。受信者自身の credentials と audience の一致、主体/鍵/token/grant の失効を Cr 側で検査する。inactive は拒否。
- claims: `{kind:'workload', sub, aud, iat, exp, jti, cnf:{public_key}, grants:[{action,resource,keys?}]}`。時刻は ISO8601、TTL 最大60秒、未来 iat は許容しない。`sub`/`aud` は拠点を含む workload ID（例 `site-a/excubitor`）。`cnf.public_key` は当該 workload の Ed25519 SPKI PEM 公開鍵。Cr の既存 service token kind は受け付けない。
- proof: Ed25519 署名。version、method、path+query、timestamp、nonce、body SHA256、audience、token SHA256 を JSON 配列で束縛する。秘密鍵はその拠点の env で供給する。公開鍵は Cr の検証結果のみから得る。
- TLS 必須。listener の `EXCUBITOR_FEDERATION_TLS_CERT_FILE` / `EXCUBITOR_FEDERATION_TLS_KEY_FILE` を管理者が配備する。クライアント・Cr 認証受信側とも HTTPS 以外を拒否する。TLS 終端 proxy を使う場合も backend まで HTTPS を維持し、`X-Forwarded-*` を TLS 証明として信用しない。
- nonce は SQLite の一意制約で受理済み要求を保持し、再起動後も再送を拒否する。token 有効期限まで記録し、期限切れだけ削除する。

## 操作と資源

| 操作 | 資源 |
|---|---|
| monitor | `node:<audience>` |
| operation:<実 action> | `service:<code>` または `service:excubitor` |
| hq-config | `service:concordia` |
| vault | `service:<code>`、さらに keys の完全一致 allowlist |
| bundle | `repository:<owner/name>` |

AI spawn は Ex mesh で許可しない。HQ 設定は deploy とは別 grant。operation の閲覧は requester peer 本人に限定する。Vault は coverage を参照せず、許可された keys のみ返し、missing も同じ allowlist で絞る。待機 operation は実行直前にも Cr を照会する。token が有効なうちは同じ token を introspection し直し、キュー待ちで期限を過ぎた場合や再起動でメモリ上の許可情報を失った場合は、下の「キュー待ち operation の再認可」で同じ範囲の認可を取り直す。取り直せなければ理由付きで失敗にする。実行開始後の副作用の巻戻しはしない。Vault の新規解決で控えを使うのは一時障害のときだけで、失効・拒否では使わず破棄する ([vault](vault.md#SPEC-VAULT-CACHE-FALLBACK))。すでに実行中のプロセスが保持する秘密は回収できない。

mesh 配布物は受信者側の管理済み `artifacts`（repository → bundle SHA256）に固定する。peer の申告値を trust anchor にしない。download 後、clone/fetch/merge 前に digest を検査する。incremental bundle はバイト列が変わるため承認済み全量 bundle を用いる。未承認 artifact は拒否。

loopback 管理面の `/api/*` と `/mcp` 全methodには同じ Host/Origin/Fetch Metadata と変更要求の JSON 検査を加える。MCP の tool proxy が Origin を失う前に入口で拒否する。MCP GET/DELETE は引き続き405。これはブラウザ経路の対策であり、ローカル悪性プロセス/SSRF に対する管理API credentials の代替ではない。管理API認証の既存利用者移行は残課題として扱う。

Ex→ローカルCcのHQ設定 caller は管理者 mesh設定の `concordia: {audience:"<site>/concordia"}` を使う。Ex peer audience から推測しない。送信直前に独立 `hq-config` / `service:concordia` token をCr HTTPSで発行し、PUT `/v1/federation/site` の本文・宛先・tokenを署名する。Ccへの接続はcatalog portの固定loopback HTTP（Ccの既存ローカル管理入口）に限定し、redirectを拒否する。remote meshとCrのHTTPS要件を変更しない。未設定・発行/鍵失敗なら送信せず、旧共有tokenへ戻らない。失敗応答と通信例外の本文を履歴へ転載しない。Ccのinbound許可とCr grantにEx主体→Cc宛先を別途管理者が配備する必要があり、本変更でlive設定は作らない。

一般管理認証の追加設計には caller の移行が必要。ブラウザUIはCernereの認証済み・接続中 user session と資源権限を要求し、CLI/MCPはそのsessionの受渡しを明示する。remote federationは既存Cr workload経路に留める。UI/APIから独立static bearerを作る案は採用しない。service control/update、release build、runtime/Infisical設定、peer/coverage管理、local operation、MCP toolの各入口が同じ管理認可を通る構成を別途設計する。現在のHost/Originガードだけで一般管理認証が完了したとは扱わない。

## 移行用 legacy-monitor {#SPEC-SECURITY-MESH-LEGACY-MONITOR}

参照: actio:b4c5bde3-fcda-47da-b528-6f9c0857ebb7

既存拠点を新しい版へ更新した時点では、Cr workload の設定 (`EXCUBITOR_MESH_SECURITY_FILE`) がまだ無い。その状態で
mesh 要求をすべて 503 にすると拠点監視が止まる。黙って fail-open にはせず、管理者が明示的に有効にする移行スイッチを置く。

- 有効化: その拠点の管理者が `npm run mesh:legacy-monitor -- enable --reason "<理由・期限>"` を実行する。
  `%APPDATA%/Excubitor/mesh-legacy-monitor.json` (非 Windows は `$XDG_CONFIG_HOME` か `~/.config`、
  `EXCUBITOR_MESH_LEGACY_MONITOR_FILE` で上書き可) を作る。リポジトリの外に置くので、git の更新では有効にも無効にもならない。
  `status` で状態を表示し、`disable` でファイルを消す。要求ごとに読むので、無効化に再起動は要らない。
- 効く範囲: 設定ファイルが **未配備** のときだけ効く。設定ファイルがあれば常にそちらが優先され、読めない・不正なファイルは
  従来どおり 503 で、移行スイッチには落ちない。
- 有効中は、登録済みで有効な peer を legacy-monitor (旧共有鍵 + HMAC 署名) として扱い、`GET /api/v1/federation/health` と
  `GET /api/v1/federation/node` の監視だけを通す。operation (更新・配備・HQ 設定)、bundle、Vault 配布は送信側・受信側の
  両方で拒否する (`legacy_monitor_only`)。cr-v1 の要求は 503 にし、移行スイッチで Cr 認証を代替しない。
- 警告: 起動時に warn ログを出す。管理画面 (拠点メッシュ画面) は `/api/v1/federation/self` の `mesh_auth` を読み、
  上部にバナーを出す。設定済みでも legacy-monitor の peer が残っていれば同じく警告する。
- 共有鍵による監視のなりすましリスクは残る。cr-v1 の配備後に `disable` し、peer ごとの `legacy-monitor` も外す。
- 判断は純関数 `security/legacy-monitor.ts`、ファイルの読み書きは `security/legacy-monitor-store.ts`、管理者コマンドは
  `security/legacy-monitor-cli.ts`。

## キュー待ち operation の再認可 {#SPEC-SECURITY-MESH-REAUTHORIZATION}

参照: actio:b4c5bde3-fcda-47da-b528-6f9c0857ebb7

Cr token の TTL は最大 60 秒なので、日次更新や先行 operation の待ちで期限を過ぎることがある。受信側は token を
自分で作れないため、依頼元に同じ範囲の token を取り直してもらう。

1. 依頼元 (管理者が UI/API から `POST /api/v1/peers/:id/operations` を出した拠点) は、相手が 202 で受け付けた依頼を
   `(peer, 相手の operation id, action, resource, 送った本文の SHA-256)` としてメモリに控える (24 時間、1 回限り)。
2. 受信側は受け付け時に、受け取った本文の SHA-256 を operation の meta (`request_digest`、秘密ではない) に残す。
3. 実行直前に token が期限切れ (またはメモリ上の許可を再起動で失った) なら、受信側は依頼元の
   `POST /api/v1/federation/operations/reauthorize` に `{operation_id, action, resource, request_digest}` を送る。
   この要求は受信側自身の cr-v1 workload 認証 (`monitor` / `node:<依頼元>`) で送る。
4. 依頼元は、要求した peer・operation id・action・resource・digest がすべて控えと一致したときだけ、Cr から
   新しい token を発行する (Cr はこの時点の grant を確認する)。そのうえで
   `POST /api/v1/federation/operations/<id>/execute` と本文 `["excubitor-execute-v1", id, action, resource, digest]`
   を束縛した Ed25519 proof を返す。控えは使い切る。
5. 受信側は返ってきた token と proof を通常の mesh 要求と同じ手順で検証する (Cr introspection、sub = 依頼元 peer、
   aud = 自分、proof、nonce)。そのうえで、同じ action/resource の grant があることを確かめてから実行する。
6. どこかで失敗したら、operation を `remote_operation_unauthorized: <理由>` で失敗にし、手順 (`authorize`) にも理由を残す。
   範囲 (action / resource / digest) を変えた token は proof が一致しないので通らない。

依頼元が再起動して控えを失った場合は再認可できず、理由付きで失敗する (管理者が出し直す)。
判断は `security/reauthorization.ts`・`operations/outbound-approvals.ts`、I/O は `operations/reauthorize-queued.ts`
(受信側)・`operations/reauthorize-routes.ts` と `security/reauthorization-issuer.ts` (依頼元) に置く。

## bundle digest 承認の運用手順 {#SPEC-SECURITY-MESH-BUNDLE-APPROVAL}

参照: actio:b4c5bde3-fcda-47da-b528-6f9c0857ebb7

- **誰が**: bundle を **受け取る拠点の管理者** が承認する。送る拠点・依頼元の申告値は trust anchor にしない。
- **どこで**: 受け取る拠点の `EXCUBITOR_MESH_SECURITY_FILE` の `artifacts` (`"owner/name": "<sha256>"`) に書く。
  UI・API・mesh からは変更できない。
- **手順**:
  1. 送る拠点の管理者が、配る commit (main の HEAD) を受け取る拠点の管理者へ伝える (mesh 外の連絡経路で)。
  2. 受け取る拠点で mesh 更新を一度依頼すると、未承認のため取り込まずに止まる。依頼の手順 `mesh_approval` に
     `sha256=<受け取った全量 bundle の digest>, main=<bundle の main commit>` が残る (bundle のヘッダを読むだけで、取り込みはしない)。
     この main commit が 1. で伝えられた commit と一致することを確かめる。
  3. 一致したときだけ、その digest を `artifacts` に登録して更新を出し直す。digest が変わる (新しい commit を配る) たびに
     同じ手順を繰り返す。不一致・不明な bundle は登録しない。
- 再認可は承認済みの digest を変えない。digest は受け取る拠点の設定から読み、要求ごとに検査する。
- 未確定: 送る拠点は要求のたびに `git bundle create` で全量 bundle を作り直す。同じ commit でもバイト列 (= digest) が
  毎回同じかは git の pack 生成に依存し、未検証。一致しない運用が見つかったら、承認済み bundle を固定して配る方式を別途決める。

## 管理画面の Host/Origin allowlist {#SPEC-SECURITY-BROWSER-ALLOWLIST}

参照: actio:b4c5bde3-fcda-47da-b528-6f9c0857ebb7

既定は従来どおり、Host は loopback (`localhost` / `127.0.0.1` / `[::1]`) だけで、Origin は同一 origin だけを許す厳しい検査のまま。
旧来の公開 URL (Cloudflare Tunnel 等) や拠点 IP から管理画面を開く拠点だけ、管理者が拠点ごとの env で origin を明示する。

```
EXCUBITOR_ADMIN_ALLOWED_ORIGINS=https://ex.example.com,http://site.example.test:17332
```

- 値は `scheme://host[:port]` の完全一致だけを受け付ける。wildcard・path・認証情報・http(s) 以外は無視し、起動時に warn を出す。
  有効な allowlist があるときも、起動時に許可した origin を warn で記録する。
- Host がその origin の host のときだけ通し、Origin はリストにあって、かつ同じ host を宛先にするものだけを許す。
  公開 origin から loopback や別の host へ宛てた要求は拒否する。`Sec-Fetch-Site` と JSON 必須の検査は変えない。
- catalog は全拠点で共有するので、この設定は catalog に書かない。起動時に 1 回読む (変更は Ex の再起動で反映)。
- 判断は純関数 `src/security/browser-allowlist.ts`、env の読み取りは `browser-allowlist-env.ts`。
- これはブラウザ経路の境界であり、管理 API の認証の代わりにはならない (下の残課題は変わらない)。

移行手順: (1) 従来どおりのアクセスが 403 `invalid_host` / `invalid_origin` になる拠点を確認する。(2) その拠点の env に
実際に使う origin だけを書いて Ex を再起動する。(3) 起動ログの許可 origin を確認する。(4) 不要になった origin は外す。

## 既存運用を止めない配備順 (Excubitor 側)

Concordia `spec/feature/cc-workload-security.md`「既存運用を止めない配備順」の手順 3 にあたる。

1. 更新前に、監視を続ける拠点で `npm run mesh:legacy-monitor -- enable --reason ...` を実行しておく (監視だけを維持)。
2. 新しい版へ更新する。起動ログと拠点メッシュ画面に legacy-monitor の警告が出ることを確認する。
3. 公開 URL・拠点 IP から管理画面を使う拠点は `EXCUBITOR_ADMIN_ALLOWED_ORIGINS` を設定する。
4. Cr workload の登録・鍵・TLS を配備し、`EXCUBITOR_MESH_SECURITY_FILE` を置く (このとき移行スイッチは自動的に効かなくなる)。
5. 拠点ごとに cr-v1 で相互接続を確認したら `disable` し、旧共有鍵を失効させる。

## 移行と未確定事項

管理承認 → Cr workload 登録/鍵生成 → 相互接続試験 → HTTPS 経路確認 → peer ごとに cr-v1 配備 → 旧資格情報失効。コード追加で live key、Cr 登録、CF、接続先を変更しない。共有鍵の暫定監視に残るなりすましリスクは解消扱いにしない。全 peer 移行と旧鍵撤去が最終条件。

Cr/Cc の実装・Actio 登録はこの worktree の外で親セッションが調整する。既存 Actio 参照を再利用し、タスクを重複作成しない。テスト実行は本文で禁止されているため、契約集計は未充足をそのまま報告する。
