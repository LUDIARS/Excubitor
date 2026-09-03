# passphrase-gate — なまえ + 共通あいことば の入場ゲート Worker

先方 (社外) に確認してもらうサイトを、メールドメインや IdP で縛らずに
「なまえ」と「全員共通のあいことば」で開け、誰がいつ何を見たかをログに残す Worker。
Cloudflare Access は使わない (Access は Worker より先に評価され、共有パスワード方式も無いため)。

## 動き

```
ブラウザ ──> <HOST> (Worker route)
               ├ Cookie 無し → 401 入場画面 (なまえ / あいことば)
               ├ あいことば一致 → 署名 Cookie (pg_session, 既定 12h) を発行
               └ Cookie 有り → そのままオリジン (cloudflared) へ通す
```

- Worker のサブリクエストは同じ Worker を再起動しないので、同一ホスト名 1 本で足りる。
- オリジンには `X-Gate-Visitor-Id` / `X-Gate-Visitor-Name` (URL エンコード) が届く。
- `/__gate/logout` で Cookie 破棄。

## ログ

すべて 1 行 JSON で `console.log` に出す。Workers Logs (dashboard > Workers > passphrase-gate > Logs)
で `event` や `name` で検索できる。ログには自己申告名と接続元 IP が含まれるため、閲覧権限と
保存期間を必要最小限にする。query / Referer / User-Agent / Cookie / あいことばは記録しない。

| event | いつ | 主なフィールド |
|---|---|---|
| `challenge` | 未認証で入場画面を出した | path, ip |
| `login` | あいことば一致 | id, name, ip |
| `login_rejected` | あいことば不一致 | ip |
| `access` | 認証済みリクエストを通した | id, name, method, path, ip |
| `logout` | ログアウト | id, name |

## セットアップ

1. `wrangler.toml` の `<HOST>` `<ZONE>` を埋める。
2. 秘密を投入:
   ```
   npx wrangler secret put PASSPHRASE      # 全員共通のあいことば
   # または: npx wrangler secret put PASSPHRASE_SHA256
   npx wrangler secret put COOKIE_SECRET   # openssl rand -base64 48
   ```
3. `npx wrangler deploy`

`PASSPHRASE_SHA256` を使う場合は 64 文字の SHA-256 hex、`COOKIE_SECRET` は 32 byte 以上が必須。
不足・不正な設定では Worker は fail-fast し、保護対象をオリジンへ転送しない。

必要な API トークン権限 (wrangler 用): `Workers Scripts:Edit`, `Zone:Workers Routes:Edit`。
Excubitor の Tunnel broker トークンとは別物。

## 運用メモ

- あいことばを変えても発行済 Cookie は TTL まで有効。即時に全員を追い出すなら
  `COOKIE_SECRET` を差し替える。
- 総当たり対策は失敗時 800ms 遅延のみ。必要なら WAF の Rate Limiting ルールを
  `POST <HOST>/__gate/login` に掛ける (例: 10 回/分/IP)。
- なまえは自己申告で、認可には使わない (ログの識別用)。

詳細な要求と trust boundary は [`spec/feature/passphrase-gate.md`](../../spec/feature/passphrase-gate.md)。

## テスト

```
node --test "test/**/*.test.js"
```
