# サービス別 runtime config を現在の main へ載せ直す

## 目的

サービス固有の完全な runtime config を Excubitor が暗号化保存し、対象 child process の
spawn 時だけ環境変数として渡す機能 (Revisor local PR #335) を、41 コミット進んだ現在の
main の上へ載せ直して審査を通せる状態にする。

PR は 2026-08-08 時点の main を前提にしており、その後 main へ入った
package audit 通知 / CF Tunnel 設定 / `NotificationStatus` の形変更 /
domain 宣言の `spec/data/ontology/` → `spec/domains/` 移設と衝突していた。
main 側の変更を正とし、本 PR の機能をその上へ載せ直す。

あわせて、Genius 側がまだ `EXCUBITOR_SERVICE_CONFIG_JSON` を読まない事実を spec と
設定 UI に明記し、運用者が `genius.config.json` を削除しないようにする。

## 完了条件

- `C-5 getServiceRuntimeConfig(code): 未設定サービスには null を返し、設定済みは呼び出しごとの JSON object clone だけを返す`
- `C-6 saveServiceRuntimeConfig(code, value): 保存結果は configured と keys だけを公開し、値本文も保存先パスも返さない`
- `C-7 saveServiceRuntimeConfig(code, value): JSON object でない値と不正な service code を ServiceRuntimeConfigValidationError で fail-closed にする`
- `C-8 resolveInjectEnv(svc): 対象 code の runtime config だけを EXCUBITOR_SERVICE_CONFIG_JSON へ serialize し、env は全値 string のまま返す`

## スコープ

`src/secrets/`、`src/process/inject.ts`、`frontend/src/lib/`、`frontend/src/pages/Config.tsx`、
対応テスト、`spec/feature/service-runtime-config.md`、`spec/setup/infisical.md`、
`spec/domains/env-management-and-injection.domain.json`、`spec/data/excubitor.taxonomy.json`、
`augur.contracts.json`。

## 前提と残件 (未確定のまま進めた事項)

- Genius repository 側の loader 対応 (`EXCUBITOR_SERVICE_CONFIG_JSON` を
  `genius.config.json` より優先して読む) は本 PR の範囲外で未実装。本 PR は Excubitor 側
  (保存 / 管理 API / spawn 時注入 / 設定 UI) だけを提供する。
- `augur.contracts.json` の C-1〜C-4 (main 既存分) は `module` が実パスでないため
  `contracts lint` が `stale-module` を出す。main 由来の既存事象で、本 PR では触らない。
- `@ludiars/log-weaver` は Excubitor の依存ではないため `augur inject apply --rule
  contract-wrap` による実行時観測は行っていない。述語モジュールはリポ資産として
  ユニットテストから直接検証している (`src/secrets/runtime-config-contracts.test.ts`)。
