import { randomUUID } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { FederationCaller, FederationEnv } from '../federation/peer-auth.js';
import type { RemotePeer } from '../federation/store.js';
import { sha256Bytes } from './artifact-integrity.js';
import { ColabSiteClient } from './client.js';
import { buildColabMeshRoutes } from './federation-routes.js';
import { buildLocalColabRoutes } from './local-routes.js';
import { COLAB_RESOURCE, colabActions, MESH_JOBS } from './protocol.js';
import type { ColabRunner } from './runner.js';

const id = randomUUID();
const peer = { id: 'site', base_url: 'https://colab.example', enabled: true } as RemotePeer;
const grant = { action: colabActions.status, resource: COLAB_RESOURCE };

function routes(caller: FederationCaller) {
  const get = vi.fn(() => undefined);
  const runner = { site: { hqPeerId: 'hq' }, get } as unknown as ColabRunner;
  const auth: MiddlewareHandler<FederationEnv> = async (c, next) => {
    c.set('federationCaller', caller);
    await next();
  };
  return { app: buildColabMeshRoutes(runner, auth), get };
}
const caller = (): FederationCaller => ({
  peerId: 'hq', peerName: 'HQ', claimedNode: null, authMode: 'cr-v1',
  expiresAt: Date.now() + 60_000, grants: [grant],
});

describe('Colab federation boundary', () => {
  it('requires the configured HQ, unexpired Cr authentication, exact operation and exact resource', async () => {
    const path = MESH_JOBS + '/' + id;
    for (const bad of [
      { peerId: 'other' }, { authMode: 'legacy-monitor' }, { expiresAt: Date.now() - 1 },
      { grants: [{ ...grant, action: colabActions.collect }] }, { grants: [{ ...grant, resource: 'service:excubitor' }] },
    ] satisfies Partial<FederationCaller>[]) {
      const { app, get } = routes({ ...caller(), ...bad });
      expect((await app.request(path)).status).toBe(403);
      expect(get).not.toHaveBeenCalled();
    }
    const { app, get } = routes(caller());
    expect((await app.request(path)).status).toBe(404);
    expect(get).toHaveBeenCalledWith(id);
  });

  it('rejects unsigned names and unsafe destinations at the local proxy without calling the transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new ColabSiteClient({ fetch, headers: async () => ({}) });
    const app = new Hono().route('/api/v1/colab', buildLocalColabRoutes({
      runner: {} as ColabRunner, isLocal: c => c.req.header('x-test-local') === 'yes',
      findPeer: () => peer, sitePeerId: peer.id, client,
    }));
    const get = (site: string, local: boolean) => app.request(`/api/v1/colab/peers/${site}/jobs/${id}`,
      { headers: { 'x-test-local': local ? 'yes' : 'no' } });
    expect((await get('site', false)).status).toBe(403);
    expect((await get('unregistered', true)).status).toBe(404);
    expect((await client.status({ ...peer, base_url: 'http://colab.example' }, id)).status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs the collect operation and discards corrupted or oversized streamed content', async () => {
    const bytes = Buffer.from('result');
    const headers = vi.fn(async () => ({ authorization: 'fake-proof' }));
    const peerResponse = (body: Uint8Array<ArrayBuffer>, size: number, sha256: string) => new Response(body, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), 'x-artifact-sha256': sha256 },
    });
    const doFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(peerResponse(new Uint8Array(bytes), bytes.length, sha256Bytes(bytes)))
      .mockResolvedValueOnce(peerResponse(new Uint8Array(bytes), bytes.length, '0'.repeat(64)))
      .mockResolvedValueOnce(peerResponse(new Uint8Array(bytes), 16 * 1024 * 1024 + 1, sha256Bytes(bytes)))
      .mockResolvedValueOnce(peerResponse(new Uint8Array(bytes), bytes.length - 1, sha256Bytes(bytes)));
    const client = new ColabSiteClient({ fetch: doFetch, headers });
    const name = 'model.bin';
    const response = await client.collect(peer, id, name);
    expect(await response.text()).toBe('result');
    expect(headers).toHaveBeenCalledWith(peer, 'POST', `${MESH_JOBS}/${id}/collect`, JSON.stringify({ name }),
      colabActions.collect, COLAB_RESOURCE);
    for (let i = 0; i < 3; i++) expect((await client.collect(peer, id, name)).status).toBe(502);
  });
});
