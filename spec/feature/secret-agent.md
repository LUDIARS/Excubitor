# secret-agent — 常駐 secret resolve エンドポイント

Excubitor を「常駐 secret-agent」として使い、各サービスが起動時に **自分の secret を
in-process で受け取る** 経路。env もファイルも使わない (secrets-runtime 形態C の Excubitor 実装)。

## 背景

- Excubitor は machine identity (暗号化保管) + 各サービスの Infisical マッピング
  (`config-store` 上書き / catalog `infisical` fallback) + 解決ロジック (`infisical.ts`) を既に持つ。
- 従来は spawn 時 env 注入 (`process/inject.ts`) だったが、 **env を使わない** 受け渡しとして
  常駐 resolve エンドポイントを追加した。

## エンドポイント

```
POST /api/v1/secrets/resolve          (loopback 127.0.0.1 only)
  Authorization: Bearer <agent-token>
  body: { "service": "<service-code>", "keys"?: ["NOTION_TOKEN", ...] }
  → 200 { "secrets": { "NOTION_TOKEN": "...", ... }, "project_id": "...", "environment": "..." }
  → 401 unauthorized / 400 invalid_body / 404 no_mapping / 503 no_identity / 502 fetch_failed
```

- `service` のマッピング (project_id/environment/include/exclude/prefix) を解決し、Excubitor の
  machine identity で Infisical から secret を引いて返す。
- `keys` を渡すと prefix 適用後のキー名で絞り込む。
- **値を返す唯一の経路**。`/api/v1/config/infisical` は status のみで値は返さない。

## 認証 (agent token)

- loopback bind + ローカルトークンの二段。
- token の出所 (優先順): `EXCUBITOR_AGENT_TOKEN` (env) → トークンファイル (無ければ生成、0600)。
  - 既定パス: `EXCUBITOR_AGENT_TOKEN_PATH` → `%APPDATA%/Excubitor/secret-agent.token` (リポジトリ外)。
- クライアント (各サービス) は同じ env / ファイルから token を読む (同一マシン前提)。
- 定数時間比較 (`timingSafeEqual`)。

## クライアント側

各サービスは起動時に `POST /secrets/resolve` を叩いて map を受け取り、**process memory にのみ**
保持する (env / 平文ファイルに書かない)。Tirocinium は `@tirocinium/secrets` クライアントで実装。

## 将来

- Cernere #111 の standalone `secret-agent` 正本へ移行する場合も、 本エンドポイント契約
  (`POST /secrets/resolve` + bearer token) を維持すればクライアントは無改修で差し替え可能。
- TTL キャッシュは `infisical.ts` 側 (token 5min / secret 60s) を流用。
