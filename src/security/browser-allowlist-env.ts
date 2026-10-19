import { createNamedLogger } from '../shared/logger.js';
import { parseBrowserAllowlist, type BrowserAllowlist } from './browser-allowlist.js';

/**
 * Reads the administrator allowlist once at startup (per-site env, never the shared catalog).
 *
 *   EXCUBITOR_ADMIN_ALLOWED_ORIGINS=https://ex.example.com,http://site.example.test:17332
 *
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */

export const BROWSER_ALLOWLIST_ENV = 'EXCUBITOR_ADMIN_ALLOWED_ORIGINS';

const logger = createNamedLogger('excubitor.security.browser');

export function readBrowserAllowlist(env: NodeJS.ProcessEnv = process.env): BrowserAllowlist {
  const { allowlist, invalid } = parseBrowserAllowlist(env[BROWSER_ALLOWLIST_ENV]);
  if (invalid.length > 0) logger.warn({ invalid }, `${BROWSER_ALLOWLIST_ENV} has invalid entries; they are ignored`);
  if (allowlist.origins.size > 0) {
    logger.warn({ origins: [...allowlist.origins] }, 'management API accepts browser requests from administrator-allowed origins');
  }
  return allowlist;
}
