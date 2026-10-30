/**
 * Browser-origin boundary decisions for the management API (pure).
 *
 * Default (empty allowlist) is the strict loopback-only check. An administrator can allow
 * the former public URL / site IP access by listing exact origins; nothing else widens.
 *
 * Host / Origin are client-chosen headers, so they only bound browsers. A public host (anything but
 * loopback / private-network addresses and Tailscale names) is reachable from the internet through a
 * tunnel, so every request on it must also carry a verified Cloudflare Access JWT (`requiresAccess`).
 * Without an Access configuration the public hosts are dropped at startup (fail-closed).
 *
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */

export interface BrowserAllowlist {
  /** Exact origins (`scheme://host[:port]`, lower-case, default port omitted). */
  origins: ReadonlySet<string>;
  /** Host header values derived from origins. */
  hosts: ReadonlySet<string>;
  /** Public hosts: requests on them must carry a verified Cloudflare Access JWT. */
  accessHosts: ReadonlySet<string>;
}

export const EMPTY_BROWSER_ALLOWLIST: BrowserAllowlist = { origins: new Set(), hosts: new Set(), accessHosts: new Set() };

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function ipv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * Hosts that cannot be reached through a public tunnel hostname: loopback, RFC 1918, CGNAT (Tailscale),
 * link-local, IPv6 ULA / link-local and Tailscale MagicDNS names. Everything else counts as public.
 */
export function isPrivateNetworkHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.includes(name) || name.endsWith('.ts.net')) return true;
  const v4 = ipv4(name);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (name.startsWith('[') && name.endsWith(']')) {
    const v6 = name.slice(1, -1);
    return /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6);
  }
  return false;
}

/** Parses a comma separated list. Invalid entries are reported and never widen the list. */
export function parseBrowserAllowlist(raw: string | undefined): { allowlist: BrowserAllowlist; invalid: string[] } {
  const origins = new Set<string>();
  const hosts = new Set<string>();
  const accessHosts = new Set<string>();
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
    if (!isPrivateNetworkHostname(url.hostname)) accessHosts.add(url.host);
  }
  return { allowlist: { origins, hosts, accessHosts }, invalid };
}

/** Removes the public origins (used when no Cloudflare Access configuration can verify them). */
export function withoutPublicOrigins(allowlist: BrowserAllowlist): BrowserAllowlist {
  const origins = new Set([...allowlist.origins].filter((origin) => !allowlist.accessHosts.has(originHost(origin) ?? '')));
  const hosts = new Set([...allowlist.hosts].filter((host) => !allowlist.accessHosts.has(host)));
  return { origins, hosts, accessHosts: new Set() };
}

export type BrowserDecision =
  | { ok: true; requiresAccess: boolean }
  | { ok: false; error: 'invalid_host' | 'invalid_origin' | 'cross_site_request' };

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
  return { ok: true, requiresAccess: !loopback && input.allowlist.accessHosts.has(hostUrl.host) };
}

function originHost(origin: string): string | null {
  try { return new URL(origin).host; } catch { return null; }
}
