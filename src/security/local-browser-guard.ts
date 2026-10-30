import type { MiddlewareHandler } from 'hono';
import { EMPTY_BROWSER_ALLOWLIST, evaluateBrowserRequest, type BrowserAllowlist } from './browser-allowlist.js';
import type { AdminAccessVerifier } from './admin-access.js';

/**
 * Browser-origin boundary. Native loopback callers keep their existing API.
 * Requests on an allowlisted public host must also carry a verified Cloudflare Access JWT
 * (Host/Origin alone are client-chosen); without a verifier they are refused.
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */
export function localBrowserGuard(options: { allowlist?: BrowserAllowlist; access?: AdminAccessVerifier | null } = {}): MiddlewareHandler {
  const allowlist = options.allowlist ?? EMPTY_BROWSER_ALLOWLIST;
  const access = options.access ?? null;
  return async (c, next) => {
    const url = new URL(c.req.url);
    const decision = evaluateBrowserRequest({
      host: c.req.header('host') ?? url.host,
      protocol: url.protocol,
      origin: c.req.header('origin'),
      secFetchSite: c.req.header('sec-fetch-site'),
      allowlist,
    });
    if (!decision.ok) return c.json({ error: decision.error }, 403);
    if (decision.requiresAccess) {
      const token = c.req.header('cf-access-jwt-assertion');
      if (!access || !token || !(await access.verify(token))) return c.json({ error: 'access_required' }, 401);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.raw.body !== null) {
      const media = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (media !== 'application/json') return c.json({ error: 'json_required' }, 415);
    }
    await next();
  };
}
