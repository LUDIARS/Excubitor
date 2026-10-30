import { createNamedLogger } from '../shared/logger.js';
import { parseBrowserAllowlist, withoutPublicOrigins, type BrowserAllowlist } from './browser-allowlist.js';
import type { AccessJwtConfig } from './cf-access-jwt.js';

/**
 * Reads the administrator allowlist once at startup (per-site env, never the shared catalog).
 *
 *   EXCUBITOR_ADMIN_ALLOWED_ORIGINS=https://ex.example.com,http://site.example.test:17332
 *
 * Public origins need a Cloudflare Access configuration (runtime-config `cloudflareAccess` of excubitor):
 * every request on such a host must carry a verified Access JWT. Without one they are dropped (fail-closed).
 *
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */

export const BROWSER_ALLOWLIST_ENV = 'EXCUBITOR_ADMIN_ALLOWED_ORIGINS';

const logger = createNamedLogger('excubitor.security.browser');

export function readBrowserAllowlist(
  env: NodeJS.ProcessEnv = process.env,
  access: AccessJwtConfig | null = null,
): BrowserAllowlist {
  const parsed = parseBrowserAllowlist(env[BROWSER_ALLOWLIST_ENV]);
  const { invalid } = parsed;
  let allowlist = parsed.allowlist;
  if (invalid.length > 0) logger.warn({ invalid }, `${BROWSER_ALLOWLIST_ENV} has invalid entries; they are ignored`);
  if (allowlist.accessHosts.size > 0 && !access) {
    logger.error({ hosts: [...allowlist.accessHosts] },
      `${BROWSER_ALLOWLIST_ENV} lists public hosts but Cloudflare Access (runtime-config cloudflareAccess of excubitor) is not configured; they are disabled`);
    allowlist = withoutPublicOrigins(allowlist);
  } else if (allowlist.accessHosts.size > 0) {
    logger.warn({ hosts: [...allowlist.accessHosts] }, 'public management hosts require a verified Cloudflare Access JWT');
  }
  if (allowlist.origins.size > 0) {
    logger.warn({ origins: [...allowlist.origins] }, 'management API accepts browser requests from administrator-allowed origins');
  }
  return allowlist;
}
