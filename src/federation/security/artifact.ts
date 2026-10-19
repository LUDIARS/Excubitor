import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readMeshSecurityConfig } from './config.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:d99b36de */
import augurContract_ea457394 from './artifact.contract.js'; /* augur-inject:contract-predicate:ffc3b6f6 */

export function verifyArtifactDigest(input: { expected: string | undefined; actual: string }): boolean {
  return typeof input.expected === 'string' && /^[a-f0-9]{64}$/.test(input.expected) && input.actual === input.expected;
}
// @ts-expect-error augur-inject
verifyArtifactDigest = contract(verifyArtifactDigest, { ...augurContract_ea457394, contractId: 'C-18', mode: 'observe', sample: 1, where: 'src/federation/security/artifact.ts:5', rule: 'contract-wrap', id: 'ea457394' }); /* augur-inject:contract-wrap:ea457394 */

/** SHA-256 of a downloaded bundle (the value an administrator registers in `artifacts`). */
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function requireApprovedBundle(repository: string, file: string): Promise<void> {
  const expected = readMeshSecurityConfig().artifacts[repository];
  if (!expected) throw new Error('mesh_artifact_not_approved');
  if (!verifyArtifactDigest({ expected, actual: await fileSha256(file) })) throw new Error('mesh_artifact_digest_mismatch');
}
