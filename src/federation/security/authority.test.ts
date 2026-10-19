import { afterEach, expect, it, vi } from 'vitest';
import { introspectWorkload, issueWorkloadToken } from './authority.js';
import { securityConfig, workloadClaims } from './test-fixtures.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('authenticates only to the configured authority, forbids redirects and does not cache introspection', async () => {
  vi.stubEnv('TEST_CLIENT', 'site-local-client'); vi.stubEnv('TEST_SECRET', 'site-local-secret');
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ active: true, claims: workloadClaims() })));
  vi.stubGlobal('fetch', fetcher);
  await introspectWorkload(securityConfig(), 'opaque');
  await introspectWorkload(securityConfig(), 'opaque');
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://cr.invalid/introspect');
  expect(init.redirect).toBe('error');
  expect(JSON.parse(init.body)).toEqual({ client_id: 'site-local-client', client_secret: 'site-local-secret', token: 'opaque', audience: 'hq/excubitor' });
});
it('rejects inactive or malformed authority responses without returning a token', async () => {
  vi.stubEnv('TEST_CLIENT', 'client'); vi.stubEnv('TEST_SECRET', 'secret');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"active":false}')));
  await expect(introspectWorkload(securityConfig(), 'opaque')).rejects.toThrow();
  await expect(issueWorkloadToken(securityConfig(), 'b/ex', 'vault', 'service:demo')).rejects.toThrow();
});
