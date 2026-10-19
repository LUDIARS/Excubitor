import { requiredCredential } from './config.js';
import { issueWorkloadToken } from './authority.js';
import { meshProofHeaders } from './proof.js';
import { readMeshAuthPolicy } from './legacy-monitor-store.js';
import { executionProofTarget, type ReauthorizationScope } from './reauthorization.js';

/**
 * Requester side adapter: obtains a fresh Cr token for the recorded scope and signs the
 * execution pseudo request. Cr re-checks the requester's current grant on issue.
 *
 * @implements SPEC-SECURITY-MESH-REAUTHORIZATION
 */
export async function issueReauthorizationHeaders(peerId: string, scope: ReauthorizationScope): Promise<Record<string, string>> {
  const policy = readMeshAuthPolicy();
  if (policy.kind !== 'configured') throw new Error('mesh_security_unavailable');
  const config = policy.config;
  const peer = config.peers[peerId];
  if (peer?.mode !== 'cr-v1') throw new Error('peer_auth_not_configured');
  const token = await issueWorkloadToken(config, peer.audience, scope.action, scope.resource);
  return meshProofHeaders({
    privateKey: requiredCredential(config.local.privateKeyEnv),
    subject: config.local.subject,
    audience: peer.audience,
    token,
    ...executionProofTarget(scope),
  });
}
