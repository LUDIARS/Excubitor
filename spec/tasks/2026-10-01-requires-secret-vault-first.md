# requires_secret を Vault 優先で解決する

- Actio: actio:0a2a074e-85f7-47d0-a7b9-31c17c09cb00
- 仕様: [spec/feature/vault.md](../feature/vault.md) 「requires_secret の解決順 (Vault 優先)」

## 背景

`resolveRequiresSecretEnv` は Vault に同じキーがあっても必ず Infisical に取りに行っていた。Infisical のログインが
502 を返すため、requires_secret を持つサービス (glab / volputas / ostiarius) が起動前に失敗する。

## 分解

- [x] 解決計画を純関数に分ける (`src/process/requires-secret-plan.ts`): 要求キーを Vault 充足分と不足分に分ける
- [x] `resolveRequiresSecretEnv`: Vault で揃えば identity / Infisical を呼ばない。不足分だけ Infisical から取る。
      `resolveInjectEnv` は解決済みの Vault env を渡して二重取得しない
- [x] preflight `checkRequiresSecret` / `needsIdentity` を同じ規則に揃える
- [x] Vault で満たしたキー名をログに残す (値は出さない)
- [x] テスト: inject-requires-secret.test.ts に (a)(b)(c) と、計画関数の単体テスト
- [x] 文書: vault.md に解決順を追記
