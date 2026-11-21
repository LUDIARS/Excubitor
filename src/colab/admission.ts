import { createHash } from 'node:crypto';
import type { ColabSubmit } from './protocol.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:10a27f87 */
import augurContract_8b550fa7 from './contracts/c-40.contract.js'; /* augur-inject:contract-predicate:d22c4298 */

export function colabFingerprint(request: ColabSubmit): string {
  const { ownerId, ownerStart, programId, sourceRevision, programSha256, gpu, deadlineAt, code, data } = request;
  return createHash('sha256').update(JSON.stringify([
    ownerId, ownerStart, programId, sourceRevision, programSha256, gpu, deadlineAt, code, data,
  ])).digest('hex');
}

export function admitColabJob(input: {
  existing?: { id: string; fingerprint: string };
  fingerprint: string;
  busy: boolean;
}): { kind: 'existing'; job: { id: string } } | { kind: 'conflict' | 'busy' | 'created' } {
  if (input.existing) return input.existing.fingerprint === input.fingerprint
    ? { kind: 'existing', job: { id: input.existing.id } }
    : { kind: 'conflict' };
  return { kind: input.busy ? 'busy' : 'created' };
}
// @ts-expect-error augur-inject
admitColabJob = contract(admitColabJob, { ...augurContract_8b550fa7, contractId: 'C-40', mode: 'observe', sample: 1, where: 'src/colab/admission.ts:11', rule: 'contract-wrap', id: '8b550fa7' }); /* augur-inject:contract-wrap:8b550fa7 */
