import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requireMutualPeer, type FederationEnv, type PeerAuthDeps } from './peer-auth.js';
import { signatureHeaders } from './request-signature.js';
import { meshProofHeaders } from './security/proof.js';
import { keys, NOW, securityConfig, workloadClaims } from './security/test-fixtures.js';

const path = '/api/v1/federation/operations';
const body = '{"action":"deploy"}';
function headers(overrides: Partial<Parameters<typeof meshProofHeaders>[0]> = {}): Record<string, string> {
  return meshProofHeaders({ privateKey: keys.privateKey, subject: 'branch/excubitor', audience: 'hq/excubitor',
    token: 'opaque-token', method: 'POST', path, body, now: NOW, ...overrides });
}
function application(overrides: PeerAuthDeps = {}): Hono<FederationEnv> {
  const seen = new Set<string>();
  const app = new Hono<FederationEnv>();
  app.use('*', requireMutualPeer({ now: () => NOW, config: securityConfig,
    peers: () => [{ id: 'branch', name: 'Branch', enabled: true, token: 'old-shared-token' }],
    introspect: async () => workloadClaims(), verifyBearer: header => header === 'Bearer local-token',
    remember: (subject, nonce) => { const key = subject + nonce; if (seen.has(key)) return false; seen.add(key); return true; },
    ...overrides,
  }));
  app.all('*', c => c.json({ caller: c.get('federationCaller') }));
  return app;
}
async function post(app: Hono<FederationEnv>, auth = headers(), payload = body): Promise<Response> {
  return app.request(`https://hq.invalid${path}`, { method: 'POST', headers: auth, body: payload });
}

describe('Cr workload authentication', () => {
  it('binds the authenticated caller to the registered site/workload', async () => {
    const response = await post(application());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ caller: { peerId: 'branch', subject: 'branch/excubitor', authMode: 'cr-v1' } });
  });
  it.each(['sub', 'aud', 'kind'] as const)('rejects an invalid %s claim', async field => {
    expect((await post(application({ introspect: async () => ({ ...workloadClaims(), [field]: 'other/value' }) }))).status).toBe(401);
  });
  it('rejects invalid body, audience, token and stale proof', async () => {
    expect((await post(application(), headers(), '{}')).status).toBe(401);
    expect((await post(application(), headers({ audience: 'other/excubitor' }))).status).toBe(403);
    expect((await post(application(), { ...headers(), authorization: 'Bearer stolen-other-token' })).status).toBe(401);
    expect((await post(application(), headers({ now: NOW - 31_000 }))).status).toBe(401);
  });
  it('does not let a peer holding legacy shared tokens impersonate a migrated workload', async () => {
    const old = { authorization: 'Bearer local-token', ...signatureHeaders('old-shared-token', 'Branch', { method: 'POST', path, body }, NOW) };
    expect((await post(application(), old)).status).toBe(403);
    expect((await post(application(), { ...old, 'x-excubitor-auth': 'cr-v1', 'x-excubitor-workload': 'branch/excubitor', 'x-excubitor-audience': 'hq/excubitor' })).status).toBe(401);
  });
  it('rejects replay using the durable-store decision', async () => {
    const app = application();
    const proof = headers();
    expect((await post(app, proof)).status).toBe(200);
    expect((await post(app, proof)).status).toBe(401);
    expect((await post(application({ remember: () => false }))).status).toBe(401);
  });
  it('fails closed for Cr outage, invalid configuration, disabled peer and nonce store failure', async () => {
    expect((await post(application({ introspect: async () => { throw new Error('offline'); } }))).status).toBe(401);
    expect((await post(application({ config: () => { throw new Error('missing'); } }))).status).toBe(503);
    expect((await post(application({ peers: () => [] }))).status).toBe(403);
    expect((await post(application({ remember: () => { throw new Error('db failed'); } }))).status).toBe(503);
  });
  it('requires TLS without trusting forwarded proto', async () => {
    const response = await application().request(`http://hq.invalid${path}`, {
      method: 'POST', headers: { ...headers(), 'x-forwarded-proto': 'https' }, body,
    });
    expect(response.status).toBe(403);
  });
  it('requires fresh introspection for every request, including after revocation', async () => {
    const introspect = vi.fn().mockResolvedValueOnce(workloadClaims()).mockRejectedValueOnce(new Error('revoked'));
    const app = application({ introspect });
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(401);
    expect(introspect).toHaveBeenCalledTimes(2);
  });
  it('requires an explicit legacy-monitor mapping for old health requests', async () => {
    const health = '/api/v1/federation/health';
    const auth = { authorization: 'Bearer local-token', ...signatureHeaders('old-shared-token', 'Branch', { method: 'GET', path: health, body: '' }, NOW) };
    const config = securityConfig();
    expect((await application().request(health, { headers: auth })).status).toBe(403);
    config.peers.branch = { mode: 'legacy-monitor' };
    expect((await application({ config: () => config }).request(health, { headers: auth })).status).toBe(200);
  });
});
