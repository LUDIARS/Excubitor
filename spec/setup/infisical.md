# Infisical 初期値を入れるための設定 (WebUI)

Excubitor が各サービスの secret を解決する (secret-agent / spawn inject) には、
Excubitor 自身の **machine identity** と、 各サービスの **Infisical マッピング** が必要。
これらの初期値は **WebUI の Config ページ**から入力する。

env もファイルも生成しない。 値は `config-store` (AppData, AES-256-GCM 暗号化) に入る。
詳細な常駐 resolve の仕組みは [`secret-agent.md`](../feature/secret-agent.md) を参照。

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

### Cernere launcher credential

EducationLab用credentialはInfisicalへ保存しない。保存するのはEx自身がCernereへissuerとして
認証するための次の2キーだけである。

- `EXCUBITOR_CERNERE_CLIENT_ID`
- `EXCUBITOR_CERNERE_CLIENT_SECRET`

これらはCernere serviceのInfisical projectに置く。catalogのEducationLab `requires_secret`が
Ex内部へだけ解決し、`cernere_launch_credentials`がspawn直前に消費する。issuer値は
子envから削除し、Exが毎回生成したEducationLab用secretだけをEducationLabへ渡す。

## 3. Genius runtime configuration

Config ページの **Genius runtime configuration** から Genius の完全な JSON object を
保存できる。
保存値は `%APPDATA%/Excubitor/config.enc` 内でファイル全体ごと AES-256-GCM 暗号化され、
管理 API は設定値本文を返さない。Excubitor が Genius を spawn するときだけ、本文を
`EXCUBITOR_SERVICE_CONFIG_JSON` として child process の環境変数へ注入する。

- JSON は `dataDir` / `embedding` / `distill` / `sources` など、Genius config schema を
  満たす完全な base config を入力する。
- HTTP port は入力しない。catalog / ProcessMap が正本であり、Excubitor は
  `GENIUS_PORT` を別途注入する。
- 保存後の値を UI/API から読み戻さない。変更時は完全な JSON を再入力する。
- 設定が未保存・破損・Genius schema 不正なら、Genius は部分設定に fallback せず起動時に
  明示エラーで停止する。
- **2026-09-21 時点で Genius はまだこの環境変数を読まない** (ローカル `genius.config.json`
  と `GENIUS_*` の個別 override だけを見る)。Genius 側の loader 対応が入るまで、保存しても
  起動設定は変わらない。`genius.config.json` を削除しないこと。

詳細は [service-runtime-config.md](../feature/service-runtime-config.md) を参照。

## API (WebUI が叩く)

- `GET /api/v1/config/infisical` — identity 状態 + サービスマッピング
- `PUT /api/v1/config/infisical/identity` — identity 保存 (暗号化)
- `POST /api/v1/config/infisical/test` — 接続テスト
- `PUT /api/v1/config/infisical/services` — マッピング一括保存
- `GET /api/v1/config/services/:code/runtime-config` — runtime config の設定有無・キー名だけを取得
- `PUT /api/v1/config/services/:code/runtime-config` — `{ "config": { ... } }` を暗号化保存、
  `{ "config": null }` で削除

## 保存先

- `%APPDATA%/Excubitor/config.enc` (Windows) / `~/.config/Excubitor/config.enc` (他)
- master 鍵: `EXCUBITOR_MASTER_KEY` env → 無ければマシン束縛値 (hostname + user)
