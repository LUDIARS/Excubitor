import type { MiddlewareHandler } from 'hono';
import { EMPTY_BROWSER_ALLOWLIST, evaluateBrowserRequest, type BrowserAllowlist } from './browser-allowlist.js';

/** Browser-origin boundary. Native loopback callers keep their existing API. */
export function localBrowserGuard(options: { allowlist?: BrowserAllowlist } = {}): MiddlewareHandler {
  const allowlist = options.allowlist ?? EMPTY_BROWSER_ALLOWLIST;
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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.raw.body !== null) {
      const media = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (media !== 'application/json') return c.json({ error: 'json_required' }, 415);
    }
    await next();
  };
}
