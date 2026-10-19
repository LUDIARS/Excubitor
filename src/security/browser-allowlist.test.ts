import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { localBrowserGuard } from './local-browser-guard.js';
import { evaluateBrowserRequest, parseBrowserAllowlist, EMPTY_BROWSER_ALLOWLIST } from './browser-allowlist.js';

function app(raw?: string): Hono {
  const api = new Hono();
  api.use('*', localBrowserGuard({ allowlist: parseBrowserAllowlist(raw).allowlist }));
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
        method: 'POST', headers: { host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' });
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
  });
});
