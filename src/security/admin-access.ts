/**
 * 管理 API の公開ホスト向け Cloudflare Access 検証の組み立て (設定の読み出し + 鍵の取得 + JWT 検証)。
 *
 * team ドメインと AUD は Excubitor の runtime-config (`cloudflareAccess`、 Access アプリ作成時に
 * cf-tunnel/access-router.ts が書く) から読む。 起動時に 1 回読み、 変更は Ex の再起動で反映する。
 *
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */

import { getServiceRuntimeConfig } from '../secrets/config-store.js';
import {
  accessJwtKeyId,
  createAccessKeySource,
  parseAccessJwtConfig,
  verifyAccessJwt,
  type AccessJwtConfig,
  type AccessKeySource,
} from './cf-access-jwt.js';

export interface AdminAccessVerifier {
  verify(token: string): Promise<boolean>;
}

export function readAdminAccessConfig(): AccessJwtConfig | null {
  try {
    return parseAccessJwtConfig(getServiceRuntimeConfig('excubitor')?.cloudflareAccess);
  } catch {
    return null;
  }
}

export function createAdminAccessVerifier(
  config: AccessJwtConfig,
  keys: AccessKeySource = createAccessKeySource(config),
  now: () => number = Date.now,
): AdminAccessVerifier {
  return {
    async verify(token: string): Promise<boolean> {
      const kid = accessJwtKeyId(token);
      if (!kid) return false;
      return verifyAccessJwt(token, config, await keys.key(kid), Math.floor(now() / 1000)).ok;
    },
  };
}
