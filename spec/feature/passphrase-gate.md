# passphrase-gate — Cloudflare edge 入場ゲート {#SPEC-PASSPHRASE-GATE}

Cloudflare Tunnel の公開 hostname の前段で、自己申告名と共有あいことばによる
小規模な外部レビュー用 access gate を提供する。名前は監査ログの識別子であり、
本人確認や権限区分には使わない。

## 要求

**SPEC-PASSPHRASE-GATE** — Worker は未認証リクエストを fail-closed にし、認証済み
リクエストだけを同一 hostname の origin へ転送する。

1. `PASSPHRASE` または 64 桁 hex の `PASSPHRASE_SHA256` と、32 byte 以上の
   `COOKIE_SECRET` を必須とする。秘密や TTL が欠落・不正なら fail-fast し、origin へ
   転送しない。
2. login POST は同一 origin からだけ受け付ける。遷移先は同一 origin の path に限定し、
   URL parser が authority と解釈する `//` や backslash 形式、および gate 内部 path を拒否する。
3. session は `id`、`name`、発行時刻、失効時刻を HMAC-SHA256 で認証する。payload の型、
   発行時刻、失効時刻、設定 TTL 以内であることを検証し、Cookie は `Secure`、`HttpOnly`、
   `SameSite=Lax`、`Path=/` とする。
4. origin 転送前に gate session Cookie を除き、署名済み session 由来の visitor id / name で
   `X-Gate-Visitor-*` を上書きする。
5. login HTML は全挿入値を escape し、CSP、frame 制限、MIME sniffing 制限、no-referrer、
   no-store を返す。
6. audit log はイベント、UTC 時刻、必要な visitor 情報、method/path、接続元 IP、country に
   限定する。あいことば、Cookie、query、Referer、User-Agent は記録しない。
7. 総当たり対策は失敗応答の遅延だけに依存せず、運用時に Cloudflare WAF rate limit を
   login endpoint に設定する。

## Modules

- `workers/passphrase-gate/src/crypto.js`: passphrase 検証、署名、encoding。
- `workers/passphrase-gate/src/session.js`: session payload と Cookie。
- `workers/passphrase-gate/src/pages.js`: login HTML と response headers。
- `workers/passphrase-gate/src/proxy.js`: origin forwarding と gate Cookie 除去。
- `workers/passphrase-gate/src/index.js`: request routing、login、audit events。
