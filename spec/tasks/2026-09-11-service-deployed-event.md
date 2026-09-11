# サービスデプロイ検知イベント

## 目的

Excubitor が管理サービスの起動時に Git hash の変化を検知し、初回・同一版の再起動を除いて Concordia へ反映事実を通知する。

## 完了条件

- `C-1 resolveServiceRuntimeVersion(service): package 版を優先しても解決済み gitHash を結果に含める`
- `C-2 dispatchServiceDeployment(input): 初回と同一 hash を送信せず、hash 変化時だけ前後 hash を POST する`
- `C-3 dispatchServiceDeployment(input): 送信失敗時も最新 hash を永続化し起動フローを失敗させない`
- `C-4 serviceDeployments: service code ごとに直近 git hash を1行で永続化する`

## スコープ

`src/process/`、`src/deploy/`、`src/db/`、対応テスト、`spec/feature/`、`spec/domains/`。
