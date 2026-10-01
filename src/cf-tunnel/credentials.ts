/**
 * Cloudflare API 資格情報の解決 (cf-tunnel 専用)。
 *
 * トークンはセッション (Claude 等) へ渡さず Excubitor が保持する。取得経路:
 *   1. process.env 直指定 (EXCUBITOR_CF_API_TOKEN / EXCUBITOR_CF_ACCOUNT_ID)
 *   2. Excubitor の Vault (WebUI「環境変数」) に登録した CF_API_TOKEN / CF_ACCOUNT_ID。
 *      サービスへの紐付けは不要 (Excubitor 自身が読む)。
 *
 * どちらも揃わなければ即エラー (RULE_CODE §7.1: 無言フォールバック禁止)。
 * トークン値はログ・例外メッセージに載せない (§14)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { sharedVault, type Vault } from '../vault/vault.js';

export interface CfCredentials {
  token: string;
  accountId: string;
}

export const VAULT_KEY_TOKEN = 'CF_API_TOKEN';
export const VAULT_KEY_ACCOUNT = 'CF_ACCOUNT_ID';

/** @implements SPEC-CF-TUNNEL-ROUTES */
export async function resolveCfCredentials(
  env: NodeJS.ProcessEnv = process.env,
  vault: Pick<Vault, 'valuesOf'> = sharedVault(),
): Promise<CfCredentials> {
  // 空文字は「未設定」として扱う (accountId が '' のまま CF API を叩かないため)。
  const directToken = env.EXCUBITOR_CF_API_TOKEN?.trim() || undefined;
  const directAccount = env.EXCUBITOR_CF_ACCOUNT_ID?.trim() || undefined;
  if (directToken && directAccount) return { token: directToken, accountId: directAccount };

  const stored = await vault.valuesOf([VAULT_KEY_TOKEN, VAULT_KEY_ACCOUNT]);
  const token = directToken ?? stored[VAULT_KEY_TOKEN]?.trim();
  const accountId = directAccount ?? stored[VAULT_KEY_ACCOUNT]?.trim();
  if (token && accountId) return { token, accountId };

  const missing = [
    token ? null : `${VAULT_KEY_TOKEN} (または EXCUBITOR_CF_API_TOKEN)`,
    accountId ? null : `${VAULT_KEY_ACCOUNT} (または EXCUBITOR_CF_ACCOUNT_ID)`,
  ].filter((name): name is string => name !== null);
  throw new Error(
    `Cloudflare API 資格情報が未設定: Excubitor の Vault (WebUI「環境変数」) に ${missing.join(' / ')} を登録する`,
  );
}
