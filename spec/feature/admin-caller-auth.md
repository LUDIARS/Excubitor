# 管理 API の呼び出し元認証 (loopback でも認証する) {#SPEC-SECURITY-ADMIN-CALLER-AUTH}

- 参照: actio:74bf9f19-101b-40f1-ab13-09dfe3b61c1b (AIFormat gaps A-1〜A-5)
- 方針の正本: AIFormat `RULE_AI_SECURITY.md` §3.1.2 (管理者権限は loopback の直接操作に限る) /
  `spec/plan/2026-11-08-security-policy-gaps.md` §2.7
- 前提: [`local-secret-hardening.md`](local-secret-hardening.md) (loopback だけでは本人に限れない)
- 状態: 設計

## 何を解くか

`/api/*` と `/mcp` は `localBrowserGuard` (Host・Origin・Sec-Fetch-Site・JSON 必須) だけで守られている。
ブラウザ経由の CSRF と DNS rebinding は防げるが、**ブラウザ以外のプロセスは Origin を付けなければ
検査を通り、認証なしで管理操作ができる**。対象は同じ PC の別プロセス (汚染された依存・マルウェア)、
別 OS ユーザー、同じホスト上のサービスの SSRF、Host を loopback に書き換える転送経路。
操作者は自己申告の `x-excubitor-actor` header で記録しているため、監査で主体を確かめられない。

## 制約: AI ワークフローを著しく非効率にしない

依頼者の条件 (2026-11-08)。次を受入条件に含める。

- 資格情報は **自動で配布し、自動で付与する**。呼び出し側が token を手で取りに行く手順を作らない。
- **日常の操作 (状態参照・再起動・テスト claim) に人の確認を挟まない。**
- 人の在席確認は頻度の低い高影響操作 (§5) だけに限る。
- 強制は「観測 → 計測 → 強制」の順に入れる (§6)。既存の呼び出し元が全部対応したことを
  観測で確かめるまで、未認証の要求を止めない。

## 1. 主体と token

既存の secret-agent サービス token (`exsa1`、[`secret-agent.md`](secret-agent.md)) と同じく、
KeyStore の master 鍵から HMAC で導出し、保存しない。用途ラベルを分けて secret-agent token とは
互換にしない。

```
exma1.<principal>.<base64url(HMAC-SHA256(subkey, principal))>
subkey = HMAC-SHA256(master 鍵, 'excubitor/admin-api/caller-token/v1')
principal = svc:<service code> | ai
```

| 主体 | 誰 | 受け取り方 | scope |
|------|----|-----------|-------|
| `svc:<code>` | Ex が起動するサービス (Concordia・Breviarium 等) | Ex が起動時に env `EXCUBITOR_API_TOKEN` で注入。catalog の `admin_api.scope` で宣言したサービスだけ | 宣言した scope (`read` / `control`) |
| `ai` | AI セッション | Concordia が spawn 時に env `EXCUBITOR_API_TOKEN` で注入 (Concordia には Ex が env `EXCUBITOR_AI_API_TOKEN` で渡す。catalog の `admin_api.delegate_ai: true` のサービスだけ) | `read` + `control` + `vault-register` |
| `browser` | 管理画面を開いている人 | §3 の cookie | `admin` (高影響操作は §5 の在席確認) |
| `cli` | `excubitorctl` | 既存の named pipe (OS アカウントごとに分離済み)。HTTP を通らない | 既存どおり |

- Ex の外で起動するサービスには、管理者が `npm run agent-token -- api <principal>` で発行して渡す
  (既存の `agent-token` script に subcommand を足す)。
- token は `Authorization: Bearer` で送る。query string では受けない。
- 監査ログの主体は token から取る。`x-excubitor-actor` は「誰の依頼か」の注記としてだけ残し、
  主体として扱わない。

## 2. scope と route の対応

| scope | 許可する操作 |
|-------|-------------|
| `read` | 状態・一覧・ログ・ヘルス・トポロジ・ポート・メモリ・security report の参照 (GET)。Vault は変数名と紐付けの参照まで (値を返す API は元から無い) |
| `control` | `read` + サービスの start / stop / restart / reload (`/api/v1/services/:code/control`)、update の適用、testing claim |
| `vault-register` | Vault への値の新規登録・上書き (`PUT /api/v1/vault/entries/:name`)。削除と紐付けの変更は含まない |
| `admin` | 上記すべて + catalog・config の編集、Vault の削除と紐付け変更、federation peer・mesh・bundle、cf-tunnel / Access、netwatch の遮断、dns-filter の規則、terminal |

- route ごとの必要 scope は 1 つの表 (`src/security/admin-route-scopes.ts`) で宣言し、全 router の
  route がどれかに載っていることをテストで検査する。**表に無い route は `admin` を要求する (fail-closed)。**
- `/mcp` は MCP の tool ごとに同じ表で scope を引く。MCP の起動設定は env `EXCUBITOR_API_TOKEN` を
  header に載せる。
- secret-agent (`/api/v1/secrets/resolve`) は既存の `exsa1` 認証のまま変えない。
- 拠点間リスナー (17335) は既存の mesh 認証のまま変えない。

## 3. ブラウザの管理画面

- `npm run ctl -- excubitor open-ui` (と既存の起動ショートカット) が one-time code (32 byte 乱数、
  有効 60 秒、1 回限り) を発行し、`http://127.0.0.1:17332/auth/session?code=...` をブラウザで開く。
  code の発行は named pipe 経由 (OS アカウントに限られる)。
- `/auth/session` は code を消費して `HttpOnly; SameSite=Strict; Path=/` の session cookie を
  発行し、URL から code を消すために `/` へリダイレクトする。cookie は 12 時間で失効し、Ex の
  再起動で全失効する (メモリ保持)。
- cookie による要求にも `localBrowserGuard` の Origin / Sec-Fetch-Site 検査を続けて適用する。
- 公開ホスト (Cloudflare Access 経由) の管理画面は、方針 (管理は loopback の直接操作に限る) の
  例外になっている。env `EXCUBITOR_PUBLIC_ADMIN_SCOPE` (`admin` / `control`) で公開ホストから
  許す scope を選べるようにする。既定は今の運用を止めない `admin` とし、observe で公開ホストからの
  `admin` 操作の件数を記録する。`control` へ絞るかは人間が決める (§8)。

## 4. 転送経路の拒否と点検 (A-2 / A-5)

- Host が loopback 名の要求に `Forwarded` / `X-Forwarded-*` / `X-Real-IP` / `Cf-Connecting-Ip` /
  `Tailscale-User-*` のいずれかが付いていたら拒否する (`forwarded_to_loopback`)。転送経路が
  Host を loopback に書き換えて管理口へ渡した状態を検知するため。公開ホストの経路 (Host が
  allowlist の公開名) はこの検査の対象外。
- 起動時と 10 分ごとに、Ex が管理する Cloudflare Tunnel の ingress と `tailscale serve status --json`
  を読み、転送先に Ex の管理ポート (17332) が含まれていたら security report と diagnostic に警告を
  出す。`tailscale` が無い拠点は「未確認」として記録し、確認済みとはしない。

## 5. 高影響操作の在席確認 (A-3)

- 対象: Vault の削除と紐付け変更、catalog からのサービス削除、federation peer の登録と削除、
  cf-tunnel / Access の変更、terminal の起動。
- `browser` 主体だけが実行でき、操作の直前に **WebAuthn の user verification** (Windows Hello 等の
  プラットフォーム認証器、RP ID `localhost` / `127.0.0.1`) を要求する。成功から 5 分は同じ cookie で
  再確認しない。プロセス (AI を含む) は在席確認を代行できない。
- 認証器の登録は初回に管理画面から行う。登録が無い拠点では対象操作を拒否し、登録を促す
  (高影響操作を確認なしに戻さない)。
- 頻度の低い操作だけに限るため、AI の日常操作は影響を受けない。

## 6. 観測 → 計測 → 強制

env `EXCUBITOR_ADMIN_AUTH` = `observe` (既定) / `enforce`。

| 段階 | 動作 |
|------|------|
| observe | token・cookie の検証と scope 判定を行い、結果を記録する。未認証・scope 不足・転送 header 付きの要求は **止めずに** 記録する (method、route、User-Agent、Origin の有無、接続元ポートから引いた PID とプロセス名) |
| 計測 | `GET /api/v1/security/admin-auth/observations` (`admin`) が未対応の呼び出し元を集計して返す。管理画面に件数を出す |
| enforce | 未認証は 401、scope 不足は 403、転送 header 付きは 403 |

- enforce への切替は人間が行う。目安は「observe で 7 日間、未対応の呼び出し元が 0」。
- enforce でも `GET /api/v1/health` (と `/health`) は認証なしで返し、guard の記録処理も通さない
  ([SPEC-EX-HEALTH-CACHE-ONLY](service-overview.md#SPEC-EX-HEALTH-CACHE-ONLY))。
- 観測の記録は要求経路で DB・プロセス一覧に触れない。要求経路では (主体, route, 結果, User-Agent,
  接続元ポート) をメモリの上限付き集計に積むだけにし、接続元ポートから PID・プロセス名を引く処理と
  永続化は、既存の process snapshot を使うバックグラウンドの周期処理で行う。
- token の検証は HMAC 1 回 (master 鍵の subkey は起動時に導出してメモリに保持) で、要求ごとの
  I/O を増やさない。

## 7. 既存の呼び出し元の対応

| 呼び出し元 | 主体 | 対応 |
|-----------|------|------|
| Concordia (`src/excubitor/client.ts`) | `svc:concordia` (`control`) | env の token を header に付ける。spawn する AI セッションへ `ai` token を渡す |
| Breviarium (`excubitor-source.ts`) | `svc:breviarium` (`read`) | env の token を header に付ける |
| Actio / Cernere の secret-agent 呼び出し | `exsa1` | 変更なし |
| スキル `cc-test` / `cc-deploy` などの curl | `ai` | 手順の curl に `-H "Authorization: Bearer $EXCUBITOR_API_TOKEN"` を足す |
| Ex の MCP (`npm run mcp`) | 起動元の token | env の token を backend への要求に付ける |
| 管理画面 | `browser` | §3 |

catalog に `admin_api` を宣言するサービスは、それぞれのリポジトリの `excubitor.catalog.yaml` で行う
(Concordia・Breviarium)。

## 8. 人間の判断が要る点

1. 公開ホスト (Cloudflare Access) の管理画面に `admin` を残すか、`read` + `control` に制限するか。
2. enforce へ切り替える時期。

## 9. テスト

- token の導出・検証 (主体の取り違え、secret-agent token との非互換、改ざん、定数時間比較)
- scope 表: 全 router の全 route が表に載っていること、表に無い route が `admin` を要求すること
- guard: observe / enforce の各段階で、未認証・scope 不足・転送 header・cookie・公開ホストの判定
- `/auth/session`: code の 1 回限り・期限・cookie 属性
- 在席確認: 未登録拠点での拒否、5 分の再確認免除
- Concordia クライアントが header を付けること、AI セッションへの env 注入
