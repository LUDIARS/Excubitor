import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { bodyDigest, newNonce, type SignedRequestParts, TIMESTAMP_HEADER, NONCE_HEADER, SIGNATURE_HEADER } from '../request-signature.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:38a237d9 */
import augurContract_868429a3 from './proof.contract.js'; /* augur-inject:contract-predicate:5e946647 */

export const MESH_SUBJECT_HEADER = 'x-excubitor-workload';
export const MESH_AUDIENCE_HEADER = 'x-excubitor-audience';
export const MESH_MODE_HEADER = 'x-excubitor-auth';
export const PROOF_WINDOW_MS = 30_000;

export interface MeshProof extends SignedRequestParts { audience: string; token: string }

function canonicalProof(parts: MeshProof): Buffer {
  return Buffer.from(JSON.stringify(['excubitor-cr-v1', parts.method.toUpperCase(), parts.path,
    parts.timestamp, parts.nonce, bodyDigest(parts.body), parts.audience, bodyDigest(parts.token)]), 'utf8');
}

export function verifyMeshProof(input: { publicKey: string; parts: MeshProof; signature: string }): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(input.signature)) return false;
  try {
    const key = createPublicKey(input.publicKey);
    return key.asymmetricKeyType === 'ed25519' && verify(null, canonicalProof(input.parts), key, Buffer.from(input.signature, 'base64url'));
  } catch {
    // Malformed remote proof/key is a rejection, never an alternate authentication path.
    return false;
  }
}
// @ts-expect-error augur-inject
verifyMeshProof = contract(verifyMeshProof, { ...augurContract_868429a3, contractId: 'C-17', mode: 'observe', sample: 1, where: 'src/federation/security/proof.ts:16', rule: 'contract-wrap', id: '868429a3' }); /* augur-inject:contract-wrap:868429a3 */

export function meshProofHeaders(input: { privateKey: string; subject: string; audience: string; token: string; method: string; path: string; body: string; now?: number; nonce?: string }): Record<string, string> {
  const key = createPrivateKey(input.privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('mesh_ed25519_key_required');
  const parts: MeshProof = { ...input, timestamp: input.now ?? Date.now(), nonce: input.nonce ?? newNonce() };
  return {
    authorization: `Bearer ${input.token}`,
    [MESH_MODE_HEADER]: 'cr-v1', [MESH_SUBJECT_HEADER]: input.subject, [MESH_AUDIENCE_HEADER]: input.audience,
    [TIMESTAMP_HEADER]: String(parts.timestamp), [NONCE_HEADER]: parts.nonce,
    [SIGNATURE_HEADER]: sign(null, canonicalProof(parts), key).toString('base64url'),
  };
}
