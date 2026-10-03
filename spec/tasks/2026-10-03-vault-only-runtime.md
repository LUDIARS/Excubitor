---
task: vault-only-runtime
project: Ex
kind: implementation
created: 2026-10-03
source_session: lictor-a8c80d07-b553-41d7-85d7-0a12e87f80c9
---

# Vault-only の起動と secret-agent を実装する

参照: actio:df0d2583-2e58-4a7c-826f-d29b91cbe0fa。本文は Actio で確認済み。この文書は実装差分と検証範囲のみ記録する。
基点: abe060c977552424be3de689fe6d0f5bf3edaaf4。作業: task/vault-only-runtime-sol。

## 実装内容

Vault がある場合にも起動前に Infisical へ接続していた経路を撤去した。
requires_secret は消費サービスの binding だけで解決し、不足・空の必須値を明示エラーにする。
旧 inject=true のサービスに Vault 値がない場合も、未移行設定として失敗させる。
preflight は env 解決を一回にまとめ、identity チェックを廃止する。
secret-agent は binding 内の要求キーだけを返す。許可外キーは全体を403で拒否し、
未知bindingは404、解決失敗は秘密値や内部エラー本文を含まない502とする。
.env 生成、実データ移行・削除、稼働設定変更、サービス操作は含めない。

### 再利用探索

- 採用: resolveVaultEnv → Vault.envFor の共有／プロジェクト優先順位と境界。
- 採用: source_peer_id / getPeer / fetchVaultEnv / vault-federation / cacheEnv の既存本社取得と暗号化控え。
  ローカルbindingを先に使い、拠点の通信失敗時は取得済み控え、404は未紐付けとする意味を維持。
- 採用: planRequiresSecret、validateStartupEnv、既存runtime config・topology・service version注入。
- 不採用: Infisical fetch/identityを通常経路で再利用する案。Vault-only条件に反するため。
- 不採用: 別の同期・汎用秘密値API・プロジェクト選択パラメータ。既存境界だけで実装できるため。

### 対のテストと検証

- [x] 契約C-11〜C-13と述語を実装前に記述。
- [x] Augur plan: 正常系、consumer契約、境界・不正入力を計画。調査後の差分でnew_featureとして再計画。
- [x] inject-requires-secret.test.ts: identity/fetch非呼出し、consumer binding、不足・空値、未移行inject、優先順位。
- [x] preflight.test.ts: 単一解決、identity不要、必須不足、required_envなしでもbinding失敗を報告。
- [x] vault-resolve.test.ts: 要求部分集合、未知binding、許可外キー、認証、応答shape、内部エラー非公開。
- [x] requires-secret-plan.test.ts: 必須空文字の拒否に更新。
- [x] 既存 vault.test.ts / project-vaults.test.ts の本社取得・暗号化控え・project優先・分離ケースを再利用。
- [x] TypeScript構文解析: 変更13ファイルで構文エラー0。git diff --check正常。
- [ ] 単体・統合・起動テスト、型検査、buildは未実施。タスク本文がテスト実行と起動を禁止しているため審査へ委ねる。

### 契約証跡の制限

Augur inject apply --rule contract-wrap --diff-base abe060c... を実行。
最初はAnatomiaのsandbox外ログ保存がEPERM。worktree内logsへ変更して再実行した。
augur.inject.jsonを追加したが、生成されたwrapperは未導入の @ludiars/log-weaver と
NodeNextビルド非互換の.ts importを参照するため、inject removeで除去した。
契約と述語は保持。実行禁止のため呼出し証跡はなく、contracts reportはC-11〜C-13を含め
全件met=false / uncovered(not-injected)。成功を自己申告しない。
DELEGATION_STARTED_ATが未設定のため、集計sinceはCc run.created_atのUTC時刻を使用した。

### 後続移行

- Actioのsecret-agent-clientはproject_id/environmentを照合するため変更必須。
  応答はsource=vault、project_id/environment=null。Vaultにないenvironmentや合成元projectを偽装しない。
- Tirociniumはsecretsのみ検証し正常応答は互換。403の分類は現状fetch_failed。
- binding不足サービスの設定、他repoのenv-cli/dotenv撤去・実値確認は親管理。
- 新しい同期・可用性の判断は不要。控えの失効ポリシーと共通agent tokenの認証境界は既存のまま。
- 実行証跡の取得には、許可された審査環境でのテスト実行と契約runtime導入整備が必要。

## 受け入れ条件

C-11 resolveRequiresSecretEnv(svc): 消費サービスのVaultで必須キーを満たし、不足時は明示失敗する
C-12 resolveServiceSecrets(code): Vault binding内だけを返し、未知bindingと許可外キーは失敗する
C-13 runPreflight(services): Infisical identityを要求せずVaultと必須envの失敗をreadyへ反映する

共有／プロジェクトの優先順位と境界、本社取得・暗号化控えの意味を維持する。
通常起動・secret-agentにはInfisical fallbackも.env生成もないことを審査で確認する。
提出境界はコミット＋Revisor local PR＋委託結果報告。マージ待ちは本委託の残件に含めない。

## 審査後の修正

単一サービスの明示的な Infisical → Vault import API が Vault-only の
`resolveServiceSecrets` を流用していたため、projectId が null となり型検査で失敗した。
この API 専用の `resolveInfisicalForImport` に分離し、config store 優先のマッピング、
machine identity、include/exclude/prefix、Infisical 側の取得失敗を維持する。
成功時は実際の project ID と environment を返し、その project の Vault に登録する。
通常起動・preflight・secret-agent は引き続き Vault-only とする。
