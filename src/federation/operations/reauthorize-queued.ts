/**
 * Receiver side adapter: re-obtains authorization for a queued remote operation whose token
 * expired (or whose in-memory permit was lost) right before it runs. Same scope only.
 *
 * @implements SPEC-SECURITY-MESH-REAUTHORIZATION
 */

import { requestReauthorization, type PeerCallResult } from '../client.js';
import { cachedAuthenticationPeers, getPeer, type RemotePeer } from '../store.js';
import { introspectWorkload } from '../security/authority.js';
import { rememberMeshNonce } from '../security/nonce-store.js';
import { authenticateCrRequest, type MeshPeerRow } from '../security/cr-request-auth.js';
import { permitsMeshAction } from '../security/grants.js';
import { readMeshAuthPolicy } from '../security/legacy-monitor-store.js';
import type { MeshAuthPolicy } from '../security/legacy-monitor.js';
import { operationScope } from '../security/operation-scope.js';
import { MESH_AUDIENCE_HEADER, MESH_MODE_HEADER, MESH_SUBJECT_HEADER } from '../security/proof.js';
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../request-signature.js';
import {
  ReauthorizationResponseSchema,
  executionProofTarget,
  reauthorizationRequest,
  type PermitCheck,
  type ReauthorizationScope,
} from '../security/reauthorization.js';
import type { OperationRecord } from './store.js';

export const REQUEST_DIGEST_META = 'request_digest';

export interface ReauthorizeQueuedDeps {
  findPeer?: (id: string) => RemotePeer | null;
  policy?: () => MeshAuthPolicy;
  peers?: () => MeshPeerRow[];
  request?: (peer: RemotePeer, scope: ReauthorizationScope) => Promise<PeerCallResult<unknown>>;
  introspect?: typeof introspectWorkload;
  remember?: typeof rememberMeshNonce;
  now?: () => number;
}

const deny = (reason: string): PermitCheck => ({ ok: false, reason });

export async function reauthorizeQueuedOperation(op: OperationRecord, deps: ReauthorizeQueuedDeps = {}): Promise<PermitCheck> {
  const digest = op.meta[REQUEST_DIGEST_META];
  if (!op.requester_peer_id || typeof digest !== 'string') return deny('reauthorization_scope_unknown');
  const peer = (deps.findPeer ?? getPeer)(op.requester_peer_id);
  if (!peer || !peer.enabled) return deny('requester_peer_not_registered');
  let policy: MeshAuthPolicy;
  try { policy = (deps.policy ?? readMeshAuthPolicy)(); }
  catch { return deny('mesh_security_unavailable'); }
  if (policy.kind !== 'configured') return deny('mesh_security_unavailable');

  const scope: ReauthorizationScope = { operationId: op.id, ...operationScope(op), requestDigest: digest };
  const response = await (deps.request ?? requestReauthorization)(peer, scope);
  if (!response.ok) return deny(`requester_refused: ${response.error ?? 'unreachable'}`);
  const parsed = ReauthorizationResponseSchema.safeParse(response.data);
  if (!parsed.success) return deny('requester_response_invalid');
  const headers = parsed.data.headers;
  if (headers[MESH_MODE_HEADER] !== 'cr-v1') return deny('requester_response_invalid');

  const target = executionProofTarget(scope);
  const auth = await authenticateCrRequest({
    protocol: new URL(peer.base_url).protocol,
    subject: headers[MESH_SUBJECT_HEADER] ?? '',
    audience: headers[MESH_AUDIENCE_HEADER] ?? '',
    authorization: headers.authorization ?? '',
    signature: headers[SIGNATURE_HEADER] ?? '',
    parts: { ...target, timestamp: Number(headers[TIMESTAMP_HEADER]), nonce: headers[NONCE_HEADER] ?? '' },
    expectedPeerId: peer.id,
  }, {
    config: policy.config,
    peers: deps.peers ?? cachedAuthenticationPeers,
    introspect: deps.introspect ?? introspectWorkload,
    remember: deps.remember ?? rememberMeshNonce,
    now: deps.now ?? Date.now,
  });
  if (!auth.ok) return deny(`reauthorization_rejected: ${auth.error}`);
  const caller = { peerId: peer.id, peerName: peer.name, claimedNode: null, authMode: 'cr-v1' as const,
    subject: auth.claims.sub, audience: auth.claims.aud, expiresAt: auth.expiresAt, grants: auth.claims.grants };
  return permitsMeshAction({ caller, action: scope.action, resource: scope.resource, now: (deps.now ?? Date.now)() })
    ? { ok: true }
    : deny('operation_grant_revoked');
}

/** Requester digest of the exact request body it sent (receiver hashes the raw body it received). */
export { bodyDigest as requestDigest } from '../request-signature.js';
