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
   `EXCUBITOR_CF_ACCOUNT_ID`) か Infisical (`EXCUBITOR_CF_INFISICAL_PROJECT_ID` の
   project から `CF_API_TOKEN` / `CF_ACCOUNT_ID` を machine identity で取得、
   environment は `EXCUBITOR_CF_INFISICAL_ENV`、既定 `prod`)。どちらも無ければ即エラー
   (無言フォールバック禁止)。
2. **hostname allowlist (fail-closed)** — 変更 (add / remove) は
   `EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES` (カンマ区切り) に載る hostname のみ。
   未設定・空は全変更拒否。一覧 (list) は全 ingress を返し、変更可否を `mutable` で示す。
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

## 運用

- 想定トークンスコープは最小 (`Account / Cloudflare Tunnel / Edit`)。
- 最初の allowlist は `qs-magiclink.ai-run-do.com` のみ。広げるときは env を変更して
  Excubitor を再起動する。
