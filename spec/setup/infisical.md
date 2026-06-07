# Infisical 初期値を入れるための設定 (init-infisical)

Excubitor が各サービスの secret を解決する (secret-agent / spawn inject) には、
Excubitor 自身の **machine identity** と、 各サービスの **Infisical マッピング** が必要。
これらの初期値を対話入力で暗号化保存するのが `init-infisical` (env-cli の setup 相当)。

env もファイルも生成しない。 値は `config-store` (AppData, AES-256-GCM 暗号化) に入る。
詳細な常駐 resolve の仕組みは [`secret-agent.md`](../secret-agent.md) を参照。

## 実行

```bash
npm run init-infisical
```

対話で以下を聞かれる (空 Enter は既存値維持 / 既定値採用)。

### 1. machine identity

| 入力 | 既定 | 説明 |
|---|---|---|
| Infisical site URL | `https://app.infisical.com` | self-host なら自分の URL |
| Environment | `dev` | identity の既定 environment |
| Universal Auth Client ID | (必須) | Infisical の machine identity |
| Universal Auth Client Secret | (必須・マスク入力) | 〃 (端末に表示されない) |

保存後、 任意で「接続テスト」を選ぶと universal-auth login を試行する
(失敗しても保存は維持)。

### 2. サービス Infisical マッピング (任意)

サービスコードを入力すると、 そのサービスの project を聞く。 空 Enter で終了。

| 入力 | 説明 |
|---|---|
| サービスコード | catalog の登録名 (例 `tirocinium`) |
| project_id (workspaceId) | Infisical の project |
| environment | 既定 `dev` |
| prefix | env キー前置 (任意) |

`inject` は常に `true` で保存する。 既存マッピングはマージされ、 消えない。

## 保存先

- `%APPDATA%/Excubitor/config.enc` (Windows) / `~/.config/Excubitor/config.enc` (他)
- master 鍵: `EXCUBITOR_MASTER_KEY` env → 無ければマシン束縛値 (hostname + user)
