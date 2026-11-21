import type { ComputeJob } from './job-types.js';

export default {
  post: (result: Record<string, unknown>, job: ComputeJob) =>
    result.resource_id === job.resourceId && result.release === job.release && result.submission === job.submission
    && !Object.values(result).includes(job.launchToken)
    && Object.keys(result).every((key) => [
      'operation_id', 'job_id', 'target_id', 'runner', 'kind', 'submission', 'release', 'resource_id',
      'provider_state', 'containers', 'created_at', 'deadline', 'submitted_at', 'observed_at',
      'provider_created_at', 'started_at', 'stopped_at', 'stop_requested_at', 'released_at', 'issue',
    ].includes(key)),
};
