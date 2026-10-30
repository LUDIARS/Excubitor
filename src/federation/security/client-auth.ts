import type { RemotePeer } from '../store.js';
import { signatureHeaders } from '../request-signature.js';
import { getOrCreateMeshToken } from '../mesh-token.js';
import { localNodeName } from '../node-snapshot.js';
import { requiredCredential } from './config.js';
import { allowsLegacyMonitorPeer, isLegacyMonitorRequest } from './legacy-monitor.js';
import { readMeshAuthPolicy } from './legacy-monitor-store.js';
import { issueWorkloadToken } from './authority.js';
import { meshProofHeaders } from './proof.js';

export async function meshRequestHeaders(peer: RemotePeer, method: string, path: string, body: string, action: string, resource: string): Promise<Record<string, string>> {
  const authPolicy = readMeshAuthPolicy();
  if (!peer.enabled) throw new Error('peer_auth_not_configured');
  let headers: Record<string, string>;
  if (allowsLegacyMonitorPeer(authPolicy, peer.id)) {
    if (action !== 'monitor' || !isLegacyMonitorRequest(method, path)) throw new Error('legacy_monitor_only');
    headers = { authorization: `Bearer ${peer.token}`,
      ...signatureHeaders(getOrCreateMeshToken(), localNodeName(), { method, path, body }) };
  } else {
    const config = authPolicy.kind === 'configured' ? authPolicy.config : null;
    const policy = config?.peers[peer.id];
    if (!config || policy?.mode !== 'cr-v1') throw new Error('peer_auth_not_configured');
    const target = new URL(peer.base_url);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw new Error('mesh_https_required');
    const token = await issueWorkloadToken(config, policy.audience, action, resource === 'node:self' ? `node:${policy.audience}` : resource);
    headers = meshProofHeaders({ privateKey: requiredCredential(config.local.privateKeyEnv), subject: config.local.subject,
      audience: policy.audience, token, method, path, body });
  }
  return { ...headers,
    ...(peer.cf_access_id && peer.cf_access_secret ? { 'CF-Access-Client-Id': peer.cf_access_id, 'CF-Access-Client-Secret': peer.cf_access_secret } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  };
}
