import type { ComputeJob } from './job-types.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:dcb17e4d */
import augurContract_23952b13 from './job-action.contract.js'; /* augur-inject:contract-predicate:965520a7 */

type JobAction = 'none' | 'discard' | 'launch' | 'reconcile' | 'observe';

/** @implements SPEC-EX-AWS-COMPUTE C-31 */
export function nextJobAction(job: ComputeJob, now: number): JobAction {
  if (job.release === 'confirmed' || job.release === 'not_allocated') return 'none';
  if (job.submission === 'queued') return job.stopRequestedAt !== null || job.deadline <= now ? 'discard' : 'launch';
  return job.resourceId === null ? 'reconcile' : 'observe';
}
// @ts-expect-error augur-inject
nextJobAction = contract(nextJobAction, { ...augurContract_23952b13, contractId: 'C-31', mode: 'observe', sample: 1, where: 'src/aws-compute/job-action.ts:6', rule: 'contract-wrap', id: '23952b13' }); /* augur-inject:contract-wrap:23952b13 */
