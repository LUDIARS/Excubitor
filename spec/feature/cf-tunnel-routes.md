# cf-tunnel-routes — Cloudflare Tunnel ルート管理ブローカー {#SPEC-CF-TUNNEL-ROUTES}

Cloudflare API トークンを AI セッションへ渡さず、Excubitor が「狭い専用 API」として
Tunnel の public hostname ルート (ingress) を list / add / remove する経路。

背景: Quaestor マジックリンク (`qs-magiclink.ai-run-do.com`) はパス込みの public hostname
指定で運用しており、新機能 (パスキー署名等) が公開パスを増やすたびに CF 側のルート追加が
必要になる。ダッシュボード手作業か生トークンの受け渡ししか無かったため、Excubitor に
ブローカーを置く (Claviger の AWS デプロイ代行と同じパターン)。

## 要求

**SPEC-CF-TUNNEL-ROUTES** — Excubitor は Cloudflare Tunnel の public hostname ルートを、CF トークンを外へ出さずに list / add / remove できる。

1. **トークン境界** — CF API トークンは Excubitor プロセス内でのみ保持する。API 応答・
   ログ・エラーに載せない。取得経路は env 直指定 (`EXCUBITOR_CF_API_TOKEN` +
   `EXCUBITOR_CF_ACCOUNT_ID`) か Excubitor の Vault (WebUI「環境変数」に登録した
   `CF_API_TOKEN` / `CF_ACCOUNT_ID`。Excubitor 自身が読むのでサービスへの紐付けは不要)。
   env は項目ごとに Vault より優先する。Infisical は使わない。揃わなければ欠けている
   名前を示して即エラー (無言フォールバック禁止)。
2. **hostname allowlist (fail-closed)** — 変更 (add / remove) は allowlist
   (`EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES` のカンマ区切りが最優先、無ければ config
   store の `cfTunnel.allowedHostnames`) に載る hostname のみ。両方とも未設定・空は
   全変更拒否。一覧 (list) は全 ingress を返し、変更可否を `mutable` で示す。
3. **catch-all 保護** — hostname 無しの最終ルール (catch-all) は削除・変更対象にしない。
   CF ingress は上から評価されるため catch-all は必ず**末尾の 1 件**であり、末尾が
   hostname 無しでなければ catch-all 無しとみなして変更を中止する (途中の hostname 無し
   エントリを catch-all と誤認すると、新ルールが「既に全部を飲み込むエントリ」の後ろに
   入って無言で効かなくなる)。
4. **追加位置と重複** — 追加ルールは catch-all の直前に挿入する。同一 hostname+path の
   重複追加は拒否する。既存エントリの未知フィールド (originRequest 等) は素通しで保持する。
5. **エンドポイント** —
   ```
   GET  /api/v1/cf-tunnel/routes?tunnel=<id|name>
   POST /api/v1/cf-tunnel/routes          { tunnel?, hostname, service, path? }
   POST /api/v1/cf-tunnel/routes/remove   { tunnel?, hostname, path? }
   ```
   `tunnel` はアカウントに tunnel が 1 本だけの場合のみ省略可。失敗は
   `cf_tunnel_*_failed` + message で返す。入力拒否 (allowlist 外・重複・catch-all 不在)
   は 400、CF 側の失敗は 502 に分ける。tunnel 解決の失敗メッセージにアカウント内の
   tunnel 名を列挙しない (無関係な tunnel の存在自体を漏らさないため、件数のみ)。
6. **MCP tool** — `excubitor_cf_tunnel_routes` (action: list/add/remove) は上記 HTTP API の
   薄いクライアントに徹し、ロジック・資格情報を持たない。
7. **config store 設定 (設定 UI)** — allowlist は
   Excubitor 設定ストア (`config.enc`、暗号化) にも保存でき、設定 UI (Config → CF Tunnel)
   と `GET/PUT /api/v1/config/cf-tunnel` で編集する。env が設定されていれば常に env が
   優先される (domainRoot と同じ規則)。CF トークン値そのものはこの API で受け取らない
   (Vault にのみ置く)。旧版が保存した Infisical project / environment は読み捨て、
   保存・返却しない。status は allowlist の解決元 (`env`/`config`/`unset`) と、
   解決値とは別に config store の素の保存値 (`stored`) を示す。編集 UI は下書きに
   `stored` を使う — 解決値を下書きにすると env が設定されている間に env の値を保存して
   既存の config を潰すため。config store 由来の変更は再起動不要で即時反映される
   (毎リクエスト解決)。

8. **Access アプリ / DNS / Access 必須 route** — 同じトークン境界と allowlist の下で、
   Internal 公開の残りの手順もブローカーが持つ (Castra の `cf:*` はこの API を呼ぶ)。
   ```
   GET  /api/v1/cf-access/policies   → { policies: [{ id, name, decision }] }   (再利用ポリシー)
   POST /api/v1/cf-access/apps       { hostname, name, policy_id, service }
   POST /api/v1/cf-access/apps/remove { hostname, service? }
   POST /api/v1/cf-tunnel/dns        { hostname, tunnel? }
   POST /api/v1/cf-tunnel/routes     { ..., require_access: true }
   ```
   - apps: 同じ domain のアプリがあれば作らずに使う。無ければ self-hosted で作り、
     指定した **既存の再利用 Allow ポリシー** だけを付ける (ポリシーは作らない・Allow 以外は 400)。
     続けて組織の `auth_domain` とアプリの `aud` を検証し、サービスの runtime-config
     (`cloudflareAccess: { teamDomain, audience }`) に書く。runtime-config の他のキーは保持する。
     AUD は応答・ログに出さない (runtime-config 経由でサービスにだけ渡る)。
   - apps/remove: Access を外して公開に戻すときに使う。domain が hostname と完全一致する
     Access アプリだけを削除する (無ければ 400)。ポリシー・DNS・tunnel route は消さない。
     `service` が来たら、そのサービスの runtime-config から `cloudflareAccess` だけを外す
     (他のキーは保持し、空になれば runtime-config ごと消す)。応答は
     `{ ok, removed: { id, name, domain }, runtime_config }` で、AUD は出さない。
   - dns: tunnel にその hostname の route があるときだけ、hostname を含む zone に
     `<tunnel id>.cfargotunnel.com` への proxied CNAME を作る。同じ向き先の proxied CNAME が
     あれば何もしない。別の向き先・別種・非 proxied のレコードは上書きせず 400。
   - routes の `require_access: true`: hostname の Access アプリ (先に apps で作る) から
     `originRequest.access = { required: true, teamName, audTag: [aud] }` を付ける。
   - トークンに要る権限: Access: Apps and Policies Edit / Access: Organizations Read /
     Cloudflare Tunnel Edit / Zone Read / DNS Edit。

## 運用

- 想定トークンスコープは最小 (`Account / Cloudflare Tunnel / Edit`)。要求 8 の操作も使うなら
  Access と DNS の権限を足す。
- 最初の allowlist は `qs-magiclink.ai-run-do.com` のみ。広げるときは設定 UI
  (再起動不要) か env (要再起動) で変更する。
