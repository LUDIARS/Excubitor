import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireMutualPeer, type FederationEnv } from './peer-auth.js';
import { signatureHeaders } from './request-signature.js';

const NOW = 1_700_000_000_000;

function app(peers: Array<{ id: string; name: string; token: string; enabled: boolean }>) {
  const hono = new Hono<FederationEnv>();
  hono.post('/api/v1/federation/operations', requireMutualPeer({
    now: () => NOW,
    verifyBearer: (h) => h === 'Bearer local-token',
    peers: () => peers,
  }), (c) => c.json({ caller: c.get('federationCaller') }));
  return hono;
}

function post(hono: Hono<FederationEnv>, headers: Record<string, string>, body = '{"x":1}') {
  return hono.request('/api/v1/federation/operations', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}

const registered = [
  { id: 'p-mac', name: 'Mac', token: 'mac-token', enabled: true },
  { id: 'p-off', name: 'Old', token: 'old-token', enabled: false },
];

function signedBy(token: string, overrides: { now?: number; body?: string; nonce?: string } = {}) {
  return {
    authorization: 'Bearer local-token',
    ...signatureHeaders(token, 'kaoimac', {
      method: 'POST',
      path: '/api/v1/federation/operations',
      body: overrides.body ?? '{"x":1}',
    }, overrides.now ?? NOW, overrides.nonce),
  };
}

describe('requireMutualPeer', () => {
  it('lets a registered peer through and tells the handler who called', async () => {
    const res = await post(app(registered), signedBy('mac-token'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caller: { peerId: 'p-mac', peerName: 'Mac', claimedNode: 'kaoimac' } });
  });

  it('refuses a caller this node has not registered (mutual registration required)', async () => {
    const res = await post(app(registered), signedBy('stranger-token'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'peer_not_registered' });
  });

  it('refuses a disabled peer the same way', async () => {
    const res = await post(app(registered), signedBy('old-token'));
    expect(res.status).toBe(403);
  });

  it('checks the bearer token first', async () => {
    const res = await post(app(registered), { ...signedBy('mac-token'), authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('requires the signature headers', async () => {
    const res = await post(app(registered), { authorization: 'Bearer local-token' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'signature_required' });
  });

  it('rejects requests outside the clock window', async () => {
    const res = await post(app(registered), signedBy('mac-token', { now: NOW - 10 * 60 * 1000 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'stale_request' });
  });

  it('rejects a replayed request', async () => {
    const hono = app(registered);
    const headers = signedBy('mac-token', { nonce: 'same' });
    expect((await post(hono, headers)).status).toBe(200);
    const again = await post(hono, headers);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'replayed_request' });
  });

  it('rejects a body that was changed after signing', async () => {
    const res = await post(app(registered), signedBy('mac-token'), '{"x":2}');
    expect(res.status).toBe(403);
  });
});
