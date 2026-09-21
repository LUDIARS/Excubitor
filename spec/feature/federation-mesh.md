# federation-mesh — 拠点メッシュ・担保サービス・拠点間ヘルス

複数拠点で動く Excubitor (Ex) 同士をメッシュ状につなぎ、どの拠点がどのサービスを担保しているかと、
拠点間の死活を、どの拠点からでも確認できるようにする。

背景 (2026-09-21 neco 指示):

- それぞれの Ex の稼働エンドポイントを接続し、各 Ex が「どのサービスを担保するか」を確認できるようにする。
- 拠点間でのヘルスチェックもできるようにする。
- ヘルスは各 Ex が確かめた値をキャッシュし、それを返す。
- 拠点は各 Ex がメッシュ状に接続する。各 Ex が外部へ出られないことも考え、Tailscale や Cloudflare Mesh での接続を想定する。

第 2 弾 (2026-09-21 neco 指示):

- 各拠点の情報を確認できるようにする。
- 相互に登録しないと疎通は出来ないようにする。
- 最新の更新と再起動・デプロイ・反映をそれぞれの Ex に依頼してできるようにする。

それまでの federation (`src/federation/`) はピア登録・集約・遠隔操作を持っていたが、Ex 本体 (17332) が
loopback 専用のため他拠点から届く口が無く、集約ビューは画面を開くたびに全ピアへ直接問い合わせていた。

## 要求

### 拠点間の接続 {#SPEC-FEDERATION-MESH}

各拠点の Ex は、メッシュ網 (Tailscale / Cloudflare Mesh) の中だけで互いに届き、
管理面をメッシュ側へ出さない。

1. **拠点間専用リスナー** — `EXCUBITOR_FEDERATION_LISTEN` に自拠点のメッシュ側アドレスを書いた拠点だけ、
   そのアドレスに bind する (未設定なら起動しない)。port は省略時 Ex 自身の catalog エントリの
   `ports` (role: `federation`、17335) を使う。複数アドレスはカンマ区切り (`host` / `host:port` / `[v6]:port`)。
2. **全インターフェース bind の禁止** — `0.0.0.0` / `::` は設定エラーとして起動しない (fail-closed)。
   LAN やインターネット側に口を開けない。
3. **公開するのは他拠点向け API だけ** — `/api/v1/federation/{health,node,operations,git/bundle}` のみ。
   ピア管理・設定・ログ・制御 UI は載せない。本体 17332 は loopback のまま変えない。
4. **入口制限** — 接続元 CIDR (`EXCUBITOR_FEDERATION_ALLOW_CIDRS`、既定 `100.64.0.0/10`
   (Tailscale と Cloudflare Mesh の 100.96.0.0/12 を含む) + `fd7a:115c:a1e0::/48` + loopback) で落とした後、
   相互登録の確認 (SPEC-FEDERATION-MUTUAL-AUTH) で認可する。allowlist が不正なら起動しない (allow-all へ fallback しない)。
5. **bind の取り直し** — メッシュのインターフェースは OS 起動直後や VPN 再接続中に無いことがある。
   bind に失敗したアドレスは 30 秒ごとに取り直し、Ex の起動は止めない。状態は `/api/v1/federation/self`
   の `listener` (`enabled` / `listening` / `error`) で見える。
6. **メッシュ接続** — 各拠点が他の全拠点をピア登録する (base_url = 相手の拠点間リスナー、例
   `http://100.x.y.z:17335`)。token と base_url は各拠点の DB (`remote_peers`、token は at-rest 暗号化) に置く。

### 担保サービス {#SPEC-FEDERATION-COVERAGE}

各拠点は自分が担保するサービスの一覧を返し、メッシュ全体で
サービスごとの担保拠点を確認できる。

1. **担保の既定** — 自拠点の catalog に載っていて `disabled` でないサービスを担保する。
2. **担保の種類** — 起動定義 (`command` / `start_script` / `compose_file` / `exec`) があれば `managed`
   (起動・再起動まで引き受ける)、無ければ `observed` (生存を見るだけ)。
3. **拠点ごとの上書き** — 同じリポジトリを複数拠点に clone すると両方が担保を名乗るので、
   拠点ローカルの DB (`federation_coverage_prefs`) で「この拠点では担保しない / する」を上書きできる。
   catalog は git で全拠点に共有されるため、拠点差は catalog に書かない。
   `PUT /api/v1/federation/coverage/:code { covered: true | false | null }` (null で既定へ戻す)。
4. **指摘** — メッシュ集約はサービスごとに次を出す。
   - `duplicate_managed`: 2 拠点以上が `managed` で担保している
   - `uncovered`: どこかの catalog に載っているのに、どの拠点も担保していない
   - `down`: 担保している拠点のどこからも up が見えず、どれかが down を見ている

### 拠点間ヘルスのキャッシュ {#SPEC-FEDERATION-HEALTH-CACHE}

拠点間のヘルスは、各拠点が自分の監視ループで確かめてキャッシュした値を返す。

1. **自拠点の health** — `GET /api/v1/federation/health` は監視ループの health キャッシュ・DB の状態・
   ピア巡回キャッシュだけから組む。呼ばれても probe も他拠点への通信も起こさない。
   各サービスに `checked_at`、全体に `scan` (最後の周の開始・完了・所要・周期) を付け、受け手が鮮度を判断できる。
   死活は `up` / `down` / `unmonitored` (判定手段なし) / `unknown` (まだ 1 周もしていない)。
2. **ピア巡回** — 各拠点は `federation.peer_poll_sec` (既定 60 秒) ごとに有効な全ピアの health を取りに行き、
   メモリにキャッシュする。取得に失敗しても直前の値は残し、`stale_after_sec` (既定 180 秒) を過ぎたら
   stale と表示する。
3. **応答の検証** — 相手拠点の応答は `health-types.ts` の zod スキーマ (`schema: 2`) で検証し、合わなければ
   down として扱う。版が違えば「両拠点の Excubitor を同じ版へ」と理由を出す。403 `peer_not_registered` は
   `unregistered` (相互登録待ち)、それ以外の 401 / 403 は `unauthorized` (token の食い違い) として down と分ける。
4. **拠点間のつながり** — health 応答には自拠点から各ピアへのつながり (`links`) を含める。
   これで、どの拠点からでも A→B と B→A を別々に見たつながり表を組める (片方向だけ切れていることがある)。
5. **画面・API はキャッシュを返す** — `/api/v1/federation/mesh` / `/services` / `/coverage` はキャッシュを返すだけで、
   開くたびにピアへ問い合わせない。疎通テスト (`POST /api/v1/peers/:id/test`) だけがその場で 1 回問い合わせ、
   結果をキャッシュにも入れる。

### 相互登録 {#SPEC-FEDERATION-MUTUAL-AUTH}

相手が自分を登録していない拠点とは疎通しない。登録は一方向ではなく両方向で揃ったときだけ効く。

1. **呼び出し側の証明** — 拠点 A が拠点 B を呼ぶとき、A は B の agent token を Bearer に載せ (A が B を
   登録している証拠)、さらに **A 自身の** agent token を鍵にして要求を HMAC-SHA256 で署名する
   (`x-excubitor-node` / `-ts` / `-nonce` / `-signature`)。署名対象は method・path・時刻・nonce・本文の SHA-256。
   token 自体は送らない。
2. **受け側の確認** — B は Bearer が自分の token であることを確かめたうえで、B が登録している有効なピアの token で
   署名を検証する。一致するピアが無ければ 403 `peer_not_registered` (B が A を登録していない = 相互登録されていない)。
   一致したピアが呼び出し元として後段 (依頼の記録など) に渡る。
3. **再送の拒否** — 時刻が ±5 分を外れた要求は 401 `stale_request`、同じ nonce の再送は 401 `replayed_request`。
4. **適用範囲** — 他拠点向け公開面のすべて (health / node / operations / git bundle)。本体 17332 に載る同じ公開面にも
   同じ確認がかかる (公開面は 1 インスタンスを本体と拠点間リスナーで共有し、nonce も共有する)。
   管理面 (loopback) は従来どおり署名を要らない。

### 拠点情報 {#SPEC-FEDERATION-NODE-INFO}

各拠点の health 応答に拠点情報 (`node_info`) を載せ、どの拠点からでも他拠点の情報を確認できる。

- Excubitor: 版 (名乗っている版)、起動時の git branch / hash、起動時刻
- OS / アーキテクチャ / ホスト名 / Node.js の版、マシン全体の CPU・メモリ (監視ループの直近サンプル)
- 拠点間リスナーの状態 (有効 / bind 中のアドレス / 設定エラー)
- 登録ピア数 (有効数)、catalog のサービス数・担保数・うち管理数
- 更新の取得元 (`origin` / `mesh`。設定不正なら null)

WebUI の Federation タブでは、拠点の一覧から選んだ拠点について拠点情報・担保しているサービス・依頼の履歴を出す。
値は表示用で、認可や判定には使わない。

### 拠点への依頼 {#SPEC-FEDERATION-OPERATIONS}

相互登録済みの拠点 (と自拠点) に、サービスまたはその拠点の Excubitor 自身について次を依頼できる。

| 依頼 | 内容 |
|---|---|
| update (最新の更新) | 取得だけ (fast-forward)。build も再起動もしない |
| restart (再起動) | 再起動 |
| deploy (デプロイ) | 取得 → 依存 install → build → 起動中なら再起動 |
| reflect (反映) | build → 起動中で、走っている版がディスクの版と一致しないときだけ再起動 (版を名乗らないサービスは確かめられないので再起動) |
| start / stop | 起動 / 停止 (Excubitor 自身には使えない) |

1. **受け付け** — `POST /api/v1/federation/operations` (他拠点から) / `POST /api/v1/operations` (自拠点) は、
   本文の検証・対象の存在・担保 (担保しないと上書きしたサービスは 409)・取得元設定を確かめてから 202 で
   受け付ける。受け付けた依頼は DB (`federation_operations`) に残り、依頼元 (他拠点なら本拠点での登録ピアと
   名乗った拠点名) を記録する。
2. **実行** — 受け付けた順に 1 件ずつ実行する (デプロイ同士の衝突を避ける)。各手順 (取得・install・build・再起動) を
   記録し、最初の失敗で止める。未コミット変更のある checkout には取り込まない。build は catalog の `build_command`、
   無ければ package.json の `scripts.build` (`npm run build`)。Excubitor 自身は本体と frontend の両方を install / build する。
3. **Excubitor 自身の再起動** — supervisor に依頼し (design.md §16.4)、受理されたら依頼を `restarting` にして期待する
   git hash を残す。新しい backend の起動時に、起動した版と照合して成否を確定する。実行中のまま止まった依頼は
   失敗 (interrupted) にし、順番待ちの依頼は続きから実行する。
4. **結果の見え方** — 依頼の直近 20 件は health 応答 (`operations`) に載り、ピア巡回のキャッシュ経由で依頼元にも見える。
   依頼した直後は、UI が依頼先に状態 (`GET .../operations/:id`) を見ている間だけ聞き続ける。
5. 旧来の同期 API (`/api/v1/federation/control`・`/update` と、そのプロキシ) はこの依頼に置き換えた。

### 外部に出られない拠点の更新元 {#SPEC-FEDERATION-MESH-SOURCE}

拠点ごとの env `EXCUBITOR_UPDATE_SOURCE` で、update / deploy の取得元を決める。

- `origin` (既定): git remote から取り込む
- `mesh`: 依頼元拠点から git bundle を受け取る。依頼元は自分の checkout (catalog の `repo` で探す) の `main` から、
  依頼先の HEAD 以降だけを bundle にして渡す (`GET /api/v1/federation/git/bundle?repo=&have=`、相互登録の確認つき)。
  依頼先は `git bundle verify` → `refs/remotes/mesh/main` へ取り込み → `merge --ff-only`。
  取り込めるのは main だけなので、main 以外を checkout している repo は更新しない。
  依頼元の main がこちらの HEAD と同じなら「up to date」として何もしない。
- 値が不正なら依頼を受け付けない (既定へ黙って落とさない)。
- 依存 install は `--prefer-offline` で npm のキャッシュを優先する。npm registry に届かず必要なパッケージが
  キャッシュに無ければ、install の失敗として依頼の手順に出る (成功扱いにはしない)。

## API

公開面 (他拠点向け、相互登録の署名が必須。拠点間リスナーと本体の両方に載る):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/federation/health` | 担保サービス + キャッシュ済み死活 + つながり + 拠点情報 + 依頼の履歴 (`schema: 2`) |
| GET | `/api/v1/federation/node` | サマリ + サービス一覧 + host メトリクス (旧形式) |
| POST | `/api/v1/federation/operations` | 依頼 (202。本文は `target` (サービス or excubitor) と `action`) |
| GET | `/api/v1/federation/operations/:id` | 依頼の状態と手順 |
| GET | `/api/v1/federation/git/bundle` | repo の main を git bundle で渡す (外部に出られない拠点用) |

管理面 (loopback の本体のみ。拠点間リスナーには載せない):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/federation/self` | 拠点名 + agent token + 拠点間リスナーの状態と URL |
| GET | `/api/v1/federation/mesh` | 拠点 / 拠点間リンク / サービス × 拠点の担保表 |
| GET | `/api/v1/federation/coverage` | 自拠点の担保一覧 (死活付き) |
| PUT | `/api/v1/federation/coverage/:code` | 自拠点での担保の上書き |
| GET | `/api/v1/federation/services` | local + ピアの集約 (旧形式、ピア分はキャッシュ) |
| * | `/api/v1/peers[...]` | ピア CRUD・疎通テスト |
| POST | `/api/v1/peers/:id/operations` | ピアへ依頼を出す (相手の公開面へ署名付きで中継) |
| GET | `/api/v1/peers/:id/operations/:opId` | ピアに出した依頼の状態 |
| POST | `/api/v1/operations` | 自拠点への依頼 |
| GET | `/api/v1/operations[/:id]` | 自拠点が受けた依頼の一覧 / 状態 |

MCP: `excubitor_federation_mesh` (メッシュ集約)、`excubitor_federation_services` (旧形式)、
`excubitor_request_operation` / `excubitor_operation_status` (依頼と状態)。
WebUI: Federation タブに「拠点メッシュ」(拠点状態とつながり表、拠点を選ぶと拠点情報・担保サービス・依頼ボタン・
依頼の履歴) と「担保」(サービス × 拠点表、自拠点列で上書き)。

## 設定

| 置き場所 | キー | 既定 | 意味 |
|---|---|---|---|
| env (拠点ごと) | `EXCUBITOR_FEDERATION_LISTEN` | 未設定 = 無効 | 拠点間リスナーの bind アドレス |
| env (拠点ごと) | `EXCUBITOR_FEDERATION_ALLOW_CIDRS` | 上記の既定帯 | 接続元 allowlist |
| env (拠点ごと) | `EXCUBITOR_NODE_NAME` | hostname | 拠点名 |
| env (拠点ごと) | `EXCUBITOR_UPDATE_SOURCE` | `origin` | update / deploy の取得元 (`origin` / `mesh`) |
| `excubitor.catalog.yaml` | `excubitor.ports[role=federation]` | 17335 | 拠点間リスナーの既定 port |
| `excubitor.config.yaml` | `federation.peer_poll_sec` | 60 | ピア巡回周期 |
| 〃 | `federation.peer_timeout_ms` | 5000 | 1 ピアのタイムアウト |
| 〃 | `federation.stale_after_sec` | 180 | stale 判定 |
| DB (拠点ごと) | `remote_peers` | — | ピアの base_url / token (暗号化) |
| DB (拠点ごと) | `federation_coverage_prefs` | — | 担保の上書き |
| DB (拠点ごと) | `federation_operations` | — | 受けた依頼の履歴と状態 |

bind アドレスは拠点ごとに違うので git 共有の catalog / config ではなく env に置く。秘密 (token) は DB にだけ置く。

## 運用手順 (拠点を 1 つ足す)

1. 新拠点を Tailscale の tailnet (または Cloudflare Mesh) に参加させ、メッシュ側アドレスを確認する
   (`tailscale ip -4` など)。
2. 新拠点の Ex の env に `EXCUBITOR_FEDERATION_LISTEN=<そのアドレス>` を置き、Ex を再起動する。
   Federation タブ「このノード」に拠点間リスナーの URL が出れば bind できている。
3. 新拠点の「このノード」から token と URL を写し、既存の各拠点でピア登録する。逆向きも同様に、
   既存の各拠点の token と URL を新拠点でピア登録する (メッシュなので全組み合わせ。片方だけでは疎通しない)。
4. 各拠点の「疎通」で `接続` になることを確かめる。`相互登録待ち` は相手側がまだこちらを登録していない、
   `認証NG` は token の貼り間違い、`不達` はメッシュ到達性 (相手のリスナー未起動 / アドレス違い / ACL) を疑う。
5. 「担保」表で `複数拠点が管理` が出たサービスは、担保しない側の拠点で上書きを「担保しない」にする。
6. 外部に出られない拠点は env に `EXCUBITOR_UPDATE_SOURCE=mesh` を置く。その拠点への update / deploy は、
   依頼を出した拠点から git bundle で取り込む (依頼を出す拠点は先に自分を最新にしておく)。

Tailscale ACL / Cloudflare Mesh のポリシーで、拠点間は 17335/tcp だけ通せば足りる。
