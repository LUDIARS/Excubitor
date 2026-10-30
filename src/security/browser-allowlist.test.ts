import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { localBrowserGuard } from './local-browser-guard.js';
import {
  evaluateBrowserRequest, parseBrowserAllowlist, EMPTY_BROWSER_ALLOWLIST, isPrivateNetworkHostname, withoutPublicOrigins,
} from './browser-allowlist.js';
import type { AdminAccessVerifier } from './admin-access.js';

const VALID_JWT = 'valid-access-jwt';
const access: AdminAccessVerifier = { verify: async (token) => token === VALID_JWT };

function app(raw?: string, verifier: AdminAccessVerifier | null = access): Hono {
  const api = new Hono();
  api.use('*', localBrowserGuard({ allowlist: parseBrowserAllowlist(raw).allowlist, access: verifier }));
  api.all('*', c => c.json({ ok: true }));
  return api;
}
const publicUrl = 'https://ex.example.com';
const siteIp = 'http://100.84.227.24:17332';

describe('management API browser allowlist', () => {
  it('keeps rejecting the former public URL and site IP when no allowlist is set', async () => {
    for (const origin of [publicUrl, siteIp]) {
      const host = new URL(origin).host;
      expect((await app().request('http://localhost/api/v1/services', { headers: { host, origin } })).status).toBe(403);
      expect((await app('').request('http://localhost/api/v1/services', { headers: { host } })).status).toBe(403);
    }
  });

  it('allows only the administrator-listed origins once set', async () => {
    const guarded = app(`${publicUrl}, ${siteIp}`);
    for (const origin of [publicUrl, siteIp]) {
      const host = new URL(origin).host;
      const response = await guarded.request('http://localhost/api/v1/services', {
        method: 'POST', headers: { host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
          'cf-access-jwt-assertion': VALID_JWT }, body: '{}' });
      expect(response.status).toBe(200);
    }
    // Other hosts, a listed origin aimed at another host, and cross-site requests stay blocked.
    const blocked: Record<string, string>[] = [
      { host: 'attacker.invalid', origin: 'https://attacker.invalid' },
      { host: 'ex.example.com', origin: 'https://attacker.invalid' },
      { host: 'localhost', origin: publicUrl },
      { host: 'ex.example.com', origin: siteIp },
      { host: 'ex.example.com', origin: publicUrl, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of blocked) {
      expect((await guarded.request('http://localhost/api/v1/services', { headers })).status).toBe(403);
    }
    // Loopback behaviour is unchanged.
    expect((await guarded.request('http://localhost/api/v1/services', { headers: { origin: 'http://localhost' } })).status).toBe(200);
  });

  it('ignores wildcard, path, credential and non-http entries', () => {
    const { allowlist, invalid } = parseBrowserAllowlist('https://*.example.com,https://ex.example.com/admin,https://u:p@ex.example.com,file:///x,not a url');
    expect(allowlist.origins.size).toBe(0);
    expect(invalid).toHaveLength(5);
    expect(evaluateBrowserRequest({ host: 'ex.example.com', protocol: 'http:', origin: undefined, secFetchSite: undefined, allowlist: EMPTY_BROWSER_ALLOWLIST }))
      .toEqual({ ok: false, error: 'invalid_host' });
    expect(evaluateBrowserRequest({ host: 'localhost', protocol: 'http:', origin: undefined, secFetchSite: undefined, allowlist: EMPTY_BROWSER_ALLOWLIST }))
      .toEqual({ ok: true, requiresAccess: false });
  });

  it('requires a verified Cloudflare Access JWT on a public host, with or without Origin', async () => {
    const guarded = app(`${publicUrl}, ${siteIp}`);
    const host = 'ex.example.com';
    // The internet attack: no Origin, no Fetch Metadata, only the allowlisted Host.
    for (const path of ['/api/v1/federation/self', '/api/v1/secrets/resolve']) {
      expect((await guarded.request(`http://localhost${path}`, { headers: { host } })).status).toBe(401);
      expect((await guarded.request(`http://localhost${path}`, { headers: { host, 'cf-access-jwt-assertion': 'forged' } })).status).toBe(401);
    }
    expect((await guarded.request('http://localhost/api/v1/services', { headers: { host, 'cf-access-jwt-assertion': VALID_JWT } })).status).toBe(200);
    // A private-network site IP stays usable without Access (not reachable through a public tunnel name).
    expect((await guarded.request('http://localhost/api/v1/services', { headers: { host: new URL(siteIp).host } })).status).toBe(200);
    // Without a verifier the public host is refused even when listed.
    expect((await app(publicUrl, null).request('http://localhost/api/v1/services', { headers: { host, 'cf-access-jwt-assertion': VALID_JWT } })).status).toBe(401);
  });

  it('classifies public and private-network hosts and drops public ones when Access is missing', () => {
    for (const name of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.5', '100.84.227.24', '[fd7a:115c:a1e0::1]', 'gromac.tail1234.ts.net']) {
      expect(isPrivateNetworkHostname(name)).toBe(true);
    }
    for (const name of ['ex.example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '[2001:db8::1]']) {
      expect(isPrivateNetworkHostname(name)).toBe(false);
    }
    const { allowlist } = parseBrowserAllowlist(`${publicUrl},${siteIp}`);
    expect([...allowlist.accessHosts]).toEqual(['ex.example.com']);
    const reduced = withoutPublicOrigins(allowlist);
    expect([...reduced.origins]).toEqual([siteIp]);
    expect(reduced.hosts.has('ex.example.com')).toBe(false);
  });
});
