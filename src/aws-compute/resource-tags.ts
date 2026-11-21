import type { ComputeJob } from './job-types.js';
import { computeId, jobId } from './target-schema.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:bc29ca7f */
import augurContract_e81a5e12 from './resource-tags.contract.js'; /* augur-inject:contract-predicate:2d3baa78 */

export const OWNER_TAG = 'ludiars:owner';
export const TARGET_TAG = 'ludiars:target-id';
export const OPERATION_TAG = 'ludiars:operation-id';
export const JOB_TAG = 'ludiars:job-id';
export const EXPIRY_TAG = 'ludiars:expires-at';

export function jobTags(job: ComputeJob, owner: string): Record<string, string> {
  return {
    [OWNER_TAG]: owner,
    [TARGET_TAG]: job.target.id,
    [OPERATION_TAG]: job.id,
    [JOB_TAG]: job.jobId,
    [EXPIRY_TAG]: new Date(job.deadline).toISOString(),
  };
}

export function matchesJobTags(tags: Record<string, string>, job: ComputeJob, owner: string): boolean {
  return Object.entries(jobTags(job, owner)).every(([key, value]) => Object.hasOwn(tags, key) && tags[key] === value);
}

/** @implements SPEC-EX-AWS-COMPUTE C-32 */
export function isExpiredOwnedResource(tags: Record<string, string>, owner: string, now: number): boolean {
  const expires = Date.parse(tags[EXPIRY_TAG] ?? '');
  return tags[OWNER_TAG] === owner && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(tags[OPERATION_TAG] ?? '')
    && computeId.safeParse(tags[TARGET_TAG]).success && jobId.safeParse(tags[JOB_TAG]).success
    && Number.isFinite(expires) && new Date(expires).toISOString() === tags[EXPIRY_TAG] && expires <= now;
}
// @ts-expect-error augur-inject
isExpiredOwnedResource = contract(isExpiredOwnedResource, { ...augurContract_e81a5e12, contractId: 'C-32', mode: 'observe', sample: 1, where: 'src/aws-compute/resource-tags.ts:25', rule: 'contract-wrap', id: 'e81a5e12' }); /* augur-inject:contract-wrap:e81a5e12 */
