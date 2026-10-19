/**
 * Browser-origin boundary decisions for the management API (pure).
 *
 * Default (empty allowlist) is the strict loopback-only check. An administrator can allow
 * the former public URL / site IP access by listing exact origins; nothing else widens.
 *
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */

export interface BrowserAllowlist {
  /** Exact origins (`scheme://host[:port]`, lower-case, default port omitted). */
  origins: ReadonlySet<string>;
  /** Host header values derived from origins. */
  hosts: ReadonlySet<string>;
}

export const EMPTY_BROWSER_ALLOWLIST: BrowserAllowlist = { origins: new Set(), hosts: new Set() };

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Parses a comma separated list. Invalid entries are reported and never widen the list. */
export function parseBrowserAllowlist(raw: string | undefined): { allowlist: BrowserAllowlist; invalid: string[] } {
  const origins = new Set<string>();
  const hosts = new Set<string>();
  const invalid: string[] = [];
  for (const entry of (raw ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
    let url: URL;
    try { url = new URL(entry); } catch { invalid.push(entry); continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || entry.includes('*') || url.origin === 'null') {
      invalid.push(entry);
      continue;
    }
    origins.add(url.origin);
    hosts.add(url.host);
  }
  return { allowlist: { origins, hosts }, invalid };
}

export type BrowserDecision = { ok: true } | { ok: false; error: 'invalid_host' | 'invalid_origin' | 'cross_site_request' };

export function evaluateBrowserRequest(input: {
  host: string;
  protocol: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  allowlist: BrowserAllowlist;
}): BrowserDecision {
  let hostUrl: URL;
  try { hostUrl = new URL(`http://${input.host}`); }
  catch { return { ok: false, error: 'invalid_host' }; }
  if (hostUrl.host !== input.host.toLowerCase() || hostUrl.username || hostUrl.password) return { ok: false, error: 'invalid_host' };
  const loopback = LOOPBACK_HOSTNAMES.includes(hostUrl.hostname) && hostUrl.host === input.host;
  if (!loopback && !input.allowlist.hosts.has(hostUrl.host)) return { ok: false, error: 'invalid_host' };
  if (input.origin !== undefined) {
    const sameLoopback = loopback && input.origin === `${input.protocol}//${input.host}`;
    // An allowed origin may only address its own host (no cross-posting into loopback or another site).
    const allowed = input.allowlist.origins.has(input.origin) && originHost(input.origin) === hostUrl.host;
    if (!sameLoopback && !allowed) return { ok: false, error: 'invalid_origin' };
  }
  if (input.secFetchSite && input.secFetchSite !== 'same-origin' && input.secFetchSite !== 'none') {
    return { ok: false, error: 'cross_site_request' };
  }
  return { ok: true };
}

function originHost(origin: string): string | null {
  try { return new URL(origin).host; } catch { return null; }
}
