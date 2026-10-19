import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reauthorizeQueuedOperation, requestDigest, type ReauthorizeQueuedDeps } from './reauthorize-queued.js';
import { buildReauthorizeRoutes } from './reauthorize-routes.js';
import { clearOutboundApprovals, recordOutboundApproval, takeOutboundApproval } from './outbound-approvals.js';
import { executionProofTarget, REAUTHORIZE_PATH, type ReauthorizationScope } from '../security/reauthorization.js';
import { meshProofHeaders } from '../security/proof.js';
import { keys, NOW, securityConfig, workloadClaims } from '../security/test-fixtures.js';
import type { FederationCaller, FederationEnv } from '../peer-auth.js';
import type { OperationRecord } from './store.js';
import type { RemotePeer } from '../store.js';

const digest = requestDigest('{"target":{"kind":"service","code":"svc-a"},"action":"restart"}');
const op = { id: 'op-1', requester_peer_id: 'branch', action: 'restart', target: { kind: 'service', code: 'svc-a' },
  meta: { request_digest: digest } } as unknown as OperationRecord;
const peer = { id: 'branch', name: 'Branch', base_url: 'https://branch.invalid', enabled: true, token: 'x' } as RemotePeer;
const granted = [{ action: 'operation:restart' as const, resource: 'service:svc-a' }];

/** What the requester answers: a fresh token + proof over the given scope. */
function requesterAnswer(scope: ReauthorizationScope) {
  return { ok: true, status: 200, error: null, data: { headers: meshProofHeaders({ privateKey: keys.privateKey,
    subject: 'branch/excubitor', audience: 'hq/excubitor', token: 'fresh-token', now: NOW, ...executionProofTarget(scope) }) } };
}
function deps(overrides: ReauthorizeQueuedDeps = {}): ReauthorizeQueuedDeps {
  return {
    findPeer: () => peer,
    policy: () => ({ kind: 'configured', config: securityConfig() }),
    peers: () => [{ id: 'branch', name: 'Branch', token: 'x', enabled: true }],
    request: async (_peer, scope) => requesterAnswer(scope),
    introspect: async () => ({ ...workloadClaims(), grants: granted }),
    remember: () => true,
    now: () => NOW,
    ...overrides,
  };
}

describe('queued operation reauthorization (receiver)', () => {
  it('succeeds with a fresh Cr token for exactly the same scope', async () => {
    const request = vi.fn(async (_peer: RemotePeer, scope: ReauthorizationScope) => requesterAnswer(scope));
    expect(await reauthorizeQueuedOperation(op, deps({ request }))).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(peer, { operationId: 'op-1', action: 'operation:restart', resource: 'service:svc-a', requestDigest: digest });
  });

  it('fails with a reason when the grant was revoked, the requester refuses, or Cr rejects', async () => {
    expect(await reauthorizeQueuedOperation(op, deps({ introspect: async () => workloadClaims() })))
      .toEqual({ ok: false, reason: 'operation_grant_revoked' });
    expect(await reauthorizeQueuedOperation(op, deps({ request: async () => ({ ok: false, status: 404, data: null, error: 'HTTP 404 approval_not_found' }) })))
      .toEqual({ ok: false, reason: 'requester_refused: HTTP 404 approval_not_found' });
    expect(await reauthorizeQueuedOperation(op, deps({ introspect: async () => { throw new Error('inactive'); } })))
      .toEqual({ ok: false, reason: 'reauthorization_rejected: workload_authentication_failed' });
    expect(await reauthorizeQueuedOperation(op, deps({ policy: () => { throw new Error('mesh_security_not_configured'); } })))
      .toEqual({ ok: false, reason: 'mesh_security_unavailable' });
    expect(await reauthorizeQueuedOperation({ ...op, meta: {} }, deps())).toEqual({ ok: false, reason: 'reauthorization_scope_unknown' });
  });

  it('rejects a token signed for a different scope (action or digest cannot change)', async () => {
    for (const changed of [{ action: 'operation:deploy' }, { requestDigest: 'f'.repeat(64) }]) {
      const result = await reauthorizeQueuedOperation(op, deps({ request: async (_peer, scope) => requesterAnswer({ ...scope, ...changed }) }));
      expect(result).toEqual({ ok: false, reason: 'reauthorization_rejected: invalid_workload_proof' });
    }
  });

  it('only accepts the token from the requester peer itself', async () => {
    expect(await reauthorizeQueuedOperation(op, deps({ peers: () => [{ id: 'other', name: 'Other', token: 'x', enabled: true }] })))
      .toEqual({ ok: false, reason: 'reauthorization_rejected: peer_not_registered' });
  });
});

describe('reauthorize route (requester)', () => {
  const scope: ReauthorizationScope = { operationId: 'op-1', action: 'operation:restart', resource: 'service:svc-a', requestDigest: digest };
  const body = { operation_id: 'op-1', action: 'operation:restart', resource: 'service:svc-a', request_digest: digest };
  afterEach(clearOutboundApprovals);

  function app(caller: Partial<FederationCaller>, issue = vi.fn(async () => ({ authorization: 'Bearer fresh' }))) {
    const auth = async (c: { set: (k: 'federationCaller', v: FederationCaller) => void }, next: () => Promise<void>) => {
      c.set('federationCaller', { peerId: 'hq', peerName: 'HQ', claimedNode: null, authMode: 'cr-v1', audience: 'branch/excubitor',
        expiresAt: Date.now() + 60_000, grants: [{ action: 'monitor', resource: 'node:branch/excubitor' }], ...caller });
      await next();
    };
    const routes: Hono<FederationEnv> = buildReauthorizeRoutes({ auth: auth as never, issue });
    return { routes, issue };
  }
  const post = (routes: Hono<FederationEnv>, payload: unknown = body) => routes.request(REAUTHORIZE_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  it('issues once for an approved operation with the same scope', async () => {
    recordOutboundApproval('hq', scope);
    const { routes, issue } = app({});
    const response = await post(routes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ headers: { authorization: 'Bearer fresh' } });
    expect(issue).toHaveBeenCalledWith('hq', scope);
    expect((await post(routes)).status).toBe(404); // single use
  });

  it('refuses unknown operations, changed scope, other peers, legacy callers and Cr failure', async () => {
    recordOutboundApproval('hq', scope);
    expect((await post(app({}).routes, { ...body, action: 'operation:deploy' })).status).toBe(404);
    expect((await post(app({ peerId: 'other' }).routes)).status).toBe(404);
    expect((await post(app({ authMode: 'legacy-monitor' }).routes)).status).toBe(403);
    expect(takeOutboundApproval('hq', { ...scope, requestDigest: 'f'.repeat(64) })).toBe(false);
    const failing = app({}, vi.fn(async () => { throw new Error('revoked'); }));
    expect((await post(failing.routes)).status).toBe(503);
  });
});
