/**
 * Cloudflare API 資格情報の解決 (cf-tunnel 専用)。
 *
 * トークンはセッション (Claude 等) へ渡さず Excubitor が保持する。取得経路は 2 つ:
 *   1. process.env 直指定 (EXCUBITOR_CF_API_TOKEN / EXCUBITOR_CF_ACCOUNT_ID)
 *   2. Infisical (EXCUBITOR_CF_INFISICAL_PROJECT_ID を指す project から
 *      CF_API_TOKEN / CF_ACCOUNT_ID を Excubitor 自身の machine identity で取得)
 *
 * どちらも無ければ即エラー (RULE_CODE §7.1: 無言フォールバック禁止)。
 * トークン値はログ・例外メッセージに載せない (§14)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { fetchProjectSecrets, readIdentity } from '../secrets/infisical.js';

export interface CfCredentials {
  token: string;
  accountId: string;
}

const INFISICAL_KEY_TOKEN = 'CF_API_TOKEN';
const INFISICAL_KEY_ACCOUNT = 'CF_ACCOUNT_ID';

/** @implements SPEC-CF-TUNNEL-ROUTES */
export async function resolveCfCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CfCredentials> {
  // 空文字は「未設定」として扱う (空のまま Infisical fallback に渡すと accountId が
  // '' のまま CF API を叩いてしまう)。
  const directToken = env.EXCUBITOR_CF_API_TOKEN?.trim() || undefined;
  const directAccount = env.EXCUBITOR_CF_ACCOUNT_ID?.trim() || undefined;
  if (directToken && directAccount) return { token: directToken, accountId: directAccount };

  const projectId = env.EXCUBITOR_CF_INFISICAL_PROJECT_ID?.trim();
  if (projectId) {
    const identity = readIdentity(env);
    if (!identity) {
      throw new Error(
        'EXCUBITOR_CF_INFISICAL_PROJECT_ID はあるが Excubitor の Infisical machine identity (INFISICAL_SITE_URL / CLIENT_ID / CLIENT_SECRET) が未設定',
      );
    }
    const environment = env.EXCUBITOR_CF_INFISICAL_ENV?.trim() || 'prod';
    const secrets = await fetchProjectSecrets(identity, projectId, environment);
    const token = secrets.find((s) => s.secretKey === INFISICAL_KEY_TOKEN)?.secretValue?.trim();
    const accountId =
      directAccount ??
      secrets.find((s) => s.secretKey === INFISICAL_KEY_ACCOUNT)?.secretValue?.trim();
    if (!token || !accountId) {
      throw new Error(
        `Infisical project (${projectId}/${environment}) に ${INFISICAL_KEY_TOKEN} / ${INFISICAL_KEY_ACCOUNT} が揃っていない`,
      );
    }
    return { token, accountId };
  }

  throw new Error(
    'Cloudflare API 資格情報が未設定: EXCUBITOR_CF_API_TOKEN + EXCUBITOR_CF_ACCOUNT_ID か EXCUBITOR_CF_INFISICAL_PROJECT_ID を設定する',
  );
}
