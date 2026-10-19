import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { localBrowserGuard } from './local-browser-guard.js';

function app(): Hono { const api = new Hono(); api.use('*', localBrowserGuard()); api.all('*', c => c.json({ ok: true })); return api; }
it('accepts native JSON loopback calls and same-origin browser calls', async () => {
  for (const origin of [undefined, 'http://localhost']) {
    const result = await app().request('http://localhost/control', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: '{}' });
    expect(result.status).toBe(200);
  }
});
it('blocks rebinding hosts, cross-origin browser requests, null origin and simple content types', async () => {
  const cases: Record<string, string>[] = [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of cases) {
    expect((await app().request('http://localhost/control', { headers })).status).toBe(403);
  }
  expect((await app().request('http://localhost/control', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
});
