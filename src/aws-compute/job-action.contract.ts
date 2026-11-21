import type { ComputeJob } from './job-types.js';

export default {
  post: (result: string, job: ComputeJob, now: number) => {
    if (job.release === 'confirmed' || job.release === 'not_allocated') return result === 'none';
    if (job.submission === 'queued') {
      return result === (job.stopRequestedAt !== null || job.deadline <= now ? 'discard' : 'launch');
    }
    return result === (job.resourceId === null ? 'reconcile' : 'observe');
  },
};
