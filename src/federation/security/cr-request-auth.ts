import type { SignedRequestParts } from '../request-signature.js';
import type { MeshSecurityConfig } from './config.js';
import type { introspectWorkload } from './authority.js';
import { validateWorkloadClaims, type WorkloadClaims } from './claims.js';
import { PROOF_WINDOW_MS, verifyMeshProof } from './proof.js';
import type { rememberMeshNonce } from './nonce-store.js';

/**
 * Cr workload request authentication shared by the federation listener (peer-auth.ts) and
 * the queued-operation reauthorization (operations/reauthorize-queued.ts).
 *
 * @implements SPEC-SECURITY-MESH-CR-AUTH
 */

export interface MeshPeerRow { id: string; name: string; token: string; enabled: boolean }

export interface CrRequest {
  /** URL protocol the request arrived on (or was fetched over). */
  protocol: string;
  subject: string;
  audience: string;
  authorization: string;
  signature: string;
  parts: SignedRequestParts;
  /** When set, the authenticated workload must be this registered peer. */
  expectedPeerId?: string;
}

export interface CrAuthDeps {
  config: MeshSecurityConfig;
  peers: () => MeshPeerRow[];
  introspect: typeof introspectWorkload;
  remember: typeof rememberMeshNonce;
  now: () => number;
}

export type CrAuthResult =
  | { ok: true; peer: MeshPeerRow; claims: WorkloadClaims; token: string; expiresAt: number }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function authenticateCrRequest(request: CrRequest, deps: CrAuthDeps): Promise<CrAuthResult> {
  const { config, now } = deps;
  if (request.protocol !== 'https:') return { ok: false, status: 403, error: 'mesh_https_required' };
  const { subject, audience, parts } = request;
  const peer = deps.peers().find(entry => {
    const policy = config.peers[entry.id];
    return entry.enabled && policy?.mode === 'cr-v1' && policy.subject === subject;
  });
  if (!peer || audience !== config.local.subject || (request.expectedPeerId !== undefined && peer.id !== request.expectedPeerId)) {
    return { ok: false, status: 403, error: 'peer_not_registered' };
  }
  if (Math.abs(now() - parts.timestamp) > PROOF_WINDOW_MS) return { ok: false, status: 401, error: 'stale_request' };
  if (!request.authorization.startsWith('Bearer ') || request.authorization.length > 32_775) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const token = request.authorization.slice(7);
  let claims: WorkloadClaims;
  try {
    claims = validateWorkloadClaims({ claims: await deps.introspect(config, token), subject, audience, now: now() });
  } catch {
    // Includes inactive/revoked identity, invalid claims and authority outage. Never fallback.
    return { ok: false, status: 401, error: 'workload_authentication_failed' };
  }
  if (!verifyMeshProof({ publicKey: claims.cnf.public_key, parts: { ...parts, audience, token }, signature: request.signature })) {
    return { ok: false, status: 401, error: 'invalid_workload_proof' };
  }
  const acceptedAt = now();
  const expiresAt = Date.parse(claims.exp);
  if (expiresAt <= acceptedAt || Math.abs(acceptedAt - parts.timestamp) > PROOF_WINDOW_MS) {
    return { ok: false, status: 401, error: 'stale_request' };
  }
  try {
    if (!deps.remember(subject, parts.nonce, expiresAt, acceptedAt)) return { ok: false, status: 401, error: 'replayed_request' };
  } catch {
    return { ok: false, status: 503, error: 'replay_store_unavailable' };
  }
  return { ok: true, peer, claims, token, expiresAt };
}
