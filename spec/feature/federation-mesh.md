# federation-mesh — 拠点メッシュ・担保サービス・拠点間ヘルス {#SPEC-FEDERATION-MESH}

複数拠点で動く Excubitor (Ex) 同士をメッシュ状につなぎ、どの拠点がどのサービスを担保しているかと、
拠点間の死活を、どの拠点からでも確認できるようにする。

背景 (2026-09-21 neco 指示):

- それぞれの Ex の稼働エンドポイントを接続し、各 Ex が「どのサービスを担保するか」を確認できるようにする。
- 拠点間でのヘルスチェックもできるようにする。
- ヘルスは各 Ex が確かめた値をキャッシュし、それを返す。
- 拠点は各 Ex がメッシュ状に接続する。各 Ex が外部へ出られないことも考え、Tailscale や Cloudflare Mesh での接続を想定する。

それまでの federation (`src/federation/`) はピア登録・集約・遠隔操作を持っていたが、Ex 本体 (17332) が
loopback 専用のため他拠点から届く口が無く、集約ビューは画面を開くたびに全ピアへ直接問い合わせていた。

## 要求

**SPEC-FEDERATION-MESH** — 各拠点の Ex は、メッシュ網 (Tailscale / Cloudflare Mesh) の中だけで互いに届き、
管理面をメッシュ側へ出さない。

1. **拠点間専用リスナー** — `EXCUBITOR_FEDERATION_LISTEN` に自拠点のメッシュ側アドレスを書いた拠点だけ、
   そのアドレスに bind する (未設定なら起動しない)。port は省略時 Ex 自身の catalog エントリの
   `ports` (role: `federation`、17335) を使う。複数アドレスはカンマ区切り (`host` / `host:port` / `[v6]:port`)。
2. **全インターフェース bind の禁止** — `0.0.0.0` / `::` は設定エラーとして起動しない (fail-closed)。
   LAN やインターネット側に口を開けない。
3. **公開するのは他拠点向け API だけ** — `/api/v1/federation/{health,node,control,update}` のみ。
   ピア管理・設定・ログ・制御 UI は載せない。本体 17332 は loopback のまま変えない。
4. **二重の入口制限** — 接続元 CIDR (`EXCUBITOR_FEDERATION_ALLOW_CIDRS`、既定 `100.64.0.0/10`
   (Tailscale と Cloudflare Mesh の 100.96.0.0/12 を含む) + `fd7a:115c:a1e0::/48` + loopback) で落とした後、
   agent token (Bearer) で認可する。allowlist が不正なら起動しない (allow-all へ fallback しない)。
5. **bind の取り直し** — メッシュのインターフェースは OS 起動直後や VPN 再接続中に無いことがある。
   bind に失敗したアドレスは 30 秒ごとに取り直し、Ex の起動は止めない。状態は `/api/v1/federation/self`
   の `listener` (`enabled` / `listening` / `error`) で見える。
6. **メッシュ接続** — 各拠点が他の全拠点をピア登録する (base_url = 相手の拠点間リスナー、例
   `http://100.x.y.z:17335`)。token と base_url は各拠点の DB (`remote_peers`、token は at-rest 暗号化) に置く。

**SPEC-FEDERATION-COVERAGE** — 各拠点は自分が担保するサービスの一覧を返し、メッシュ全体で
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

**SPEC-FEDERATION-HEALTH-CACHE** — 拠点間のヘルスは、各拠点が自分の監視ループで確かめてキャッシュした値を返す。

1. **自拠点の health** — `GET /api/v1/federation/health` は監視ループの health キャッシュ・DB の状態・
   ピア巡回キャッシュだけから組む。呼ばれても probe も他拠点への通信も起こさない。
   各サービスに `checked_at`、全体に `scan` (最後の周の開始・完了・所要・周期) を付け、受け手が鮮度を判断できる。
   死活は `up` / `down` / `unmonitored` (判定手段なし) / `unknown` (まだ 1 周もしていない)。
2. **ピア巡回** — 各拠点は `federation.peer_poll_sec` (既定 60 秒) ごとに有効な全ピアの health を取りに行き、
   メモリにキャッシュする。取得に失敗しても直前の値は残し、`stale_after_sec` (既定 180 秒) を過ぎたら
   stale と表示する。
3. **応答の検証** — 相手拠点の応答は `health-types.ts` の zod スキーマ (`schema: 1`) で検証し、合わなければ
   down として扱う。401 / 403 は `unauthorized` (token の食い違い) として down と分ける。
4. **拠点間のつながり** — health 応答には自拠点から各ピアへのつながり (`links`) を含める。
   これで、どの拠点からでも A→B と B→A を別々に見たつながり表を組める (片方向だけ切れていることがある)。
5. **画面・API はキャッシュを返す** — `/api/v1/federation/mesh` / `/services` / `/coverage` はキャッシュを返すだけで、
   開くたびにピアへ問い合わせない。疎通テスト (`POST /api/v1/peers/:id/test`) だけがその場で 1 回問い合わせ、
   結果をキャッシュにも入れる。

## API

公開面 (他拠点向け、agent token 必須。拠点間リスナーと本体の両方に載る):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/federation/health` | 担保サービス + キャッシュ済み死活 + つながり (`schema: 1`) |
| GET | `/api/v1/federation/node` | サマリ + サービス一覧 + host メトリクス (旧形式) |
| POST | `/api/v1/federation/control` | 1 サービスを start / stop / restart |
| POST | `/api/v1/federation/update` | 1 サービスを更新 |

管理面 (loopback の本体のみ。拠点間リスナーには載せない):

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/v1/federation/self` | 拠点名 + agent token + 拠点間リスナーの状態と URL |
| GET | `/api/v1/federation/mesh` | 拠点 / 拠点間リンク / サービス × 拠点の担保表 |
| GET | `/api/v1/federation/coverage` | 自拠点の担保一覧 (死活付き) |
| PUT | `/api/v1/federation/coverage/:code` | 自拠点での担保の上書き |
| GET | `/api/v1/federation/services` | local + ピアの集約 (旧形式、ピア分はキャッシュ) |
| * | `/api/v1/peers[...]` | ピア CRUD・疎通テスト・遠隔操作プロキシ |

MCP: `excubitor_federation_mesh` (メッシュ集約)、`excubitor_federation_services` (旧形式)。
WebUI: Federation タブに「拠点メッシュ」(拠点状態とつながり表) と「担保」(サービス × 拠点表、自拠点列で上書き)。

## 設定

| 置き場所 | キー | 既定 | 意味 |
|---|---|---|---|
| env (拠点ごと) | `EXCUBITOR_FEDERATION_LISTEN` | 未設定 = 無効 | 拠点間リスナーの bind アドレス |
| env (拠点ごと) | `EXCUBITOR_FEDERATION_ALLOW_CIDRS` | 上記の既定帯 | 接続元 allowlist |
| env (拠点ごと) | `EXCUBITOR_NODE_NAME` | hostname | 拠点名 |
| `excubitor.catalog.yaml` | `excubitor.ports[role=federation]` | 17335 | 拠点間リスナーの既定 port |
| `excubitor.config.yaml` | `federation.peer_poll_sec` | 60 | ピア巡回周期 |
| 〃 | `federation.peer_timeout_ms` | 5000 | 1 ピアのタイムアウト |
| 〃 | `federation.stale_after_sec` | 180 | stale 判定 |
| DB (拠点ごと) | `remote_peers` | — | ピアの base_url / token (暗号化) |
| DB (拠点ごと) | `federation_coverage_prefs` | — | 担保の上書き |

bind アドレスは拠点ごとに違うので git 共有の catalog / config ではなく env に置く。秘密 (token) は DB にだけ置く。

## 運用手順 (拠点を 1 つ足す)

1. 新拠点を Tailscale の tailnet (または Cloudflare Mesh) に参加させ、メッシュ側アドレスを確認する
   (`tailscale ip -4` など)。
2. 新拠点の Ex の env に `EXCUBITOR_FEDERATION_LISTEN=<そのアドレス>` を置き、Ex を再起動する。
   Federation タブ「このノード」に拠点間リスナーの URL が出れば bind できている。
3. 新拠点の「このノード」から token と URL を写し、既存の各拠点でピア登録する。逆向きも同様に、
   既存の各拠点の token と URL を新拠点でピア登録する (メッシュなので全組み合わせ)。
4. 各拠点の「疎通」で `接続` になることを確かめる。`認証NG` は token の貼り間違い、`不達` は
   メッシュ到達性 (相手のリスナー未起動 / アドレス違い / ACL) を疑う。
5. 「担保」表で `複数拠点が管理` が出たサービスは、担保しない側の拠点で上書きを「担保しない」にする。

Tailscale ACL / Cloudflare Mesh のポリシーで、拠点間は 17335/tcp だけ通せば足りる。
