import type { ComputeJob } from './job-types.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:07b4a0e1 */
import augurContract_a5d0d10e from './job-receipt.contract.js'; /* augur-inject:contract-predicate:b6696fa6 */

function iso(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString();
}

/** @implements SPEC-EX-AWS-COMPUTE C-33 */
export function toJobReceipt(job: ComputeJob) {
  return {
    operation_id: job.id,
    job_id: job.jobId,
    target_id: job.target.id,
    runner: job.runner,
    kind: job.target.kind,
    submission: job.submission,
    release: job.release,
    resource_id: job.resourceId,
    provider_state: job.observation?.state ?? null,
    containers: job.observation?.containers ?? [],
    created_at: iso(job.createdAt),
    deadline: iso(job.deadline),
    submitted_at: iso(job.submittedAt),
    observed_at: iso(job.observedAt),
    provider_created_at: iso(job.observation?.createdAt ?? null),
    started_at: iso(job.observation?.startedAt ?? null),
    stopped_at: iso(job.observation?.stoppedAt ?? null),
    stop_requested_at: iso(job.stopRequestedAt),
    released_at: iso(job.releasedAt),
    issue: job.issue,
  };
}
// @ts-expect-error augur-inject
toJobReceipt = contract(toJobReceipt, { ...augurContract_a5d0d10e, contractId: 'C-33', mode: 'observe', sample: 1, where: 'src/aws-compute/job-receipt.ts:8', rule: 'contract-wrap', id: 'a5d0d10e' }); /* augur-inject:contract-wrap:a5d0d10e */
