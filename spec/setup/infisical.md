# Infisical 初期値を入れるための設定 (WebUI)

Excubitor が各サービスの secret を解決する (secret-agent / spawn inject) には、
Excubitor 自身の **machine identity** と、 各サービスの **Infisical マッピング** が必要。
これらの初期値は **WebUI の Config ページ**から入力する。

env もファイルも生成しない。 値は `config-store` (AppData, AES-256-GCM 暗号化) に入る。
詳細な常駐 resolve の仕組みは [`secret-agent.md`](../secret-agent.md) を参照。

## 開き方

```bash
npm run dev               # backend (17332)
cd frontend && npm run dev  # WebUI (17333)
```

ブラウザで WebUI (17333) → **Config** タブ。

## 1. machine identity

| 入力 | 既定 | 説明 |
|---|---|---|
| Site URL | `https://app.infisical.com` | self-host なら自分の URL |
| Environment | `dev` | identity の既定 environment |
| Client ID | (必須) | Infisical Universal Auth の machine identity |
| Client Secret | (必須・password 入力) | 〃 (保存後は平文を返さない、 ヒントのみ表示) |

「保存 (暗号化)」で `config-store` に保存し、 即 `process.env.INFISICAL_*` へ反映。
「接続テスト」で保存済 identity による universal-auth login を試行する
(`POST /api/v1/config/infisical/test`、 成功/失敗のみ表示、 secret は返さない)。

## 2. サービス別 Infisical マッピング

サービスごとに「どの Infisical project から env を受け取るか」を表で編集する。
ここに入れた設定は catalog より優先される。

| 列 | 説明 |
|---|---|
| service code | catalog 登録名から選択 (タイプミス防止) |
| project_id | Infisical の workspaceId |
| environment | 既定 `dev` |
| prefix | env キー前置 (任意) |
| inject | 起動時に注入するか |

「マッピングを保存」で一括保存。

## API (WebUI が叩く)

- `GET /api/v1/config/infisical` — identity 状態 + サービスマッピング
- `PUT /api/v1/config/infisical/identity` — identity 保存 (暗号化)
- `POST /api/v1/config/infisical/test` — 接続テスト
- `PUT /api/v1/config/infisical/services` — マッピング一括保存

## 保存先

- `%APPDATA%/Excubitor/config.enc` (Windows) / `~/.config/Excubitor/config.enc` (他)
- master 鍵: `EXCUBITOR_MASTER_KEY` env → 無ければマシン束縛値 (hostname + user)
