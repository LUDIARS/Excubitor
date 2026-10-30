import type { MiddlewareHandler } from 'hono';
import { verifyMeshToken } from './mesh-token.js';
import { createNonceCache } from './nonce-cache.js';
import { NONCE_HEADER, TIMESTAMP_HEADER, SIGNATURE_HEADER, SIGNATURE_MAX_SKEW_MS, verifyRequestSignature } from './request-signature.js';
import { cachedAuthenticationPeers } from './store.js';
import type { MeshSecurityConfig } from './security/config.js';
import { introspectWorkload } from './security/authority.js';
import { validateWorkloadClaims, type MeshGrant } from './security/claims.js';
import { MESH_MODE_HEADER, MESH_SUBJECT_HEADER, MESH_AUDIENCE_HEADER } from './security/proof.js';
import { rememberMeshNonce } from './security/nonce-store.js';
import { authenticateCrRequest } from './security/cr-request-auth.js';
import {
  allowsLegacyMonitorPeer,
  isLegacyMonitorRequest,
  resolveMeshAuthPolicy,
  type LegacyMonitorMigration,
  type MeshAuthPolicy,
} from './security/legacy-monitor.js';
import { readLegacyMonitorMigration, readMeshAuthPolicy } from './security/legacy-monitor-store.js';

/** @implements SPEC-SECURITY-MESH-CR-AUTH */
export interface FederationCaller {
  peerId: string;
  peerName: string;
  claimedNode: string | null;
  authMode?: 'legacy-monitor' | 'cr-v1';
  subject?: string;
  audience?: string;
  expiresAt?: number;
  grants?: MeshGrant[];
  /** Recheck current Cr policy at queued execution; never serialized or persisted. */
  reauthorize?: () => Promise<FederationCaller>;
}
export type FederationEnv = { Variables: { federationCaller: FederationCaller } };
export interface PeerAuthDeps {
  now?: () => number;
  verifyBearer?: (authorization: string | undefined) => boolean;
  peers?: () => Array<{ id: string; name: string; token: string; enabled: boolean }>;
  config?: () => MeshSecurityConfig;
  /** Migration switch reader (tests inject it; production reads the administrator file). */
  migration?: () => LegacyMonitorMigration | null;
  introspect?: typeof introspectWorkload;
  remember?: typeof rememberMeshNonce;
}

export function requireMutualPeer(deps: PeerAuthDeps = {}): MiddlewareHandler<FederationEnv> {
  const now = deps.now ?? Date.now;
  const peers = deps.peers ?? cachedAuthenticationPeers;
  const readPolicy = (): MeshAuthPolicy => deps.config
    ? resolveMeshAuthPolicy({ loadConfig: deps.config, loadMigration: deps.migration ?? (() => readLegacyMonitorMigration()) })
    : readMeshAuthPolicy();
  const introspect = deps.introspect ?? introspectWorkload;
  const remember = deps.remember ?? rememberMeshNonce;
  const legacyNonces = createNonceCache(SIGNATURE_MAX_SKEW_MS * 2);

  return async (c, next) => {
    let policy: MeshAuthPolicy;
    try { policy = readPolicy(); }
    catch { return c.json({ error: 'mesh_security_unavailable' }, 503); }
    const url = new URL(c.req.url);
    const signature = c.req.header(SIGNATURE_HEADER) ?? '';
    const nonce = c.req.header(NONCE_HEADER) ?? '';
    const timestamp = Number(c.req.header(TIMESTAMP_HEADER));
    const current = now();
    if (!signature || nonce.length < 16 || nonce.length > 128 || !/^[A-Za-z0-9_-]+$/.test(nonce) || !Number.isSafeInteger(timestamp)) {
      return c.json({ error: 'signature_required' }, 401);
    }
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text();
    if (Buffer.byteLength(body, 'utf8') > 64 * 1024) return c.json({ error: 'body_too_large' }, 413);
    const parts = { method: c.req.method, path: url.pathname + url.search, timestamp, nonce, body };
    const mode = c.req.header(MESH_MODE_HEADER);

    if (mode === 'cr-v1') {
      // The migration switch only keeps legacy monitoring alive; it never stands in for Cr.
      if (policy.kind !== 'configured') return c.json({ error: 'mesh_security_unavailable' }, 503);
      const config = policy.config;
      const auth = await authenticateCrRequest({
        protocol: url.protocol,
        subject: c.req.header(MESH_SUBJECT_HEADER) ?? '',
        audience: c.req.header(MESH_AUDIENCE_HEADER) ?? '',
        authorization: c.req.header('authorization') ?? '',
        signature,
        parts,
      }, { config, peers, introspect, remember, now });
      if (!auth.ok) return c.json({ error: auth.error }, auth.status);
      const { peer, token, expiresAt } = auth;
      const subject = auth.claims.sub;
      const audience = auth.claims.aud;
      const caller: FederationCaller = { peerId: peer.id, peerName: peer.name, claimedNode: null,
        authMode: 'cr-v1', subject, audience, expiresAt, grants: auth.claims.grants };
      caller.reauthorize = async () => {
        const latest = readPolicy();
        if (latest.kind !== 'configured') throw new Error('peer_revoked');
        const policyNow = latest.config.peers[peer.id];
        if (policyNow?.mode !== 'cr-v1' || policyNow.subject !== subject || latest.config.local.subject !== audience ||
            !peers().some(entry => entry.id === peer.id && entry.enabled)) throw new Error('peer_revoked');
        const refreshed = validateWorkloadClaims({ claims: await introspect(latest.config, token), subject, audience, now: now() });
        return { ...caller, grants: refreshed.grants, expiresAt: Date.parse(refreshed.exp) };
      };
      c.set('federationCaller', caller);
    } else {
      if (mode && mode !== 'legacy-monitor') return c.json({ error: 'unsupported_auth_mode' }, 401);
      if (!isLegacyMonitorRequest(c.req.method, url.pathname)) {
        return c.json({ error: 'legacy_monitor_only' }, 403);
      }
      if (!(deps.verifyBearer ?? verifyMeshToken)(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
      if (Math.abs(current - timestamp) > SIGNATURE_MAX_SKEW_MS) return c.json({ error: 'stale_request' }, 401);
      const peer = peers().find(entry => entry.enabled && allowsLegacyMonitorPeer(policy, entry.id) &&
        entry.token && verifyRequestSignature(entry.token, parts, signature));
      if (!peer) return c.json({ error: 'peer_not_registered' }, 403);
      if (!legacyNonces.remember(`${peer.id}:${nonce}`, current)) return c.json({ error: 'replayed_request' }, 401);
      c.set('federationCaller', { peerId: peer.id, peerName: peer.name, claimedNode: null, authMode: 'legacy-monitor' });
    }
    await next();
  };
}
