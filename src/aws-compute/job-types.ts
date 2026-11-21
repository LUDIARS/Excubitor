import type { ComputeTarget } from './target-schema.js';

export type SubmissionState = 'queued' | 'submitting' | 'unknown' | 'accepted' | 'rejected' | 'discarded';
export type ReleaseState = 'pending' | 'requested' | 'confirmed' | 'not_allocated';
export type JobIssue = 'credentials_unavailable' | 'deadline_elapsed' | 'cancelled_before_submit' | 'launch_rejected'
  | 'launch_unconfirmed' | 'resource_not_visible' | 'resource_mismatch' | 'observation_failed' | 'release_failed'
  | 'invalid_runner_configuration';

export interface ComputeJob {
  id: string;
  jobId: string;
  target: ComputeTarget;
  runner: string;
  launchToken: string;
  inputs: Record<string, string> | null;
  submission: SubmissionState;
  release: ReleaseState;
  resourceId: string | null;
  observation: ResourceObservation | null;
  issue: JobIssue | null;
  createdAt: number;
  deadline: number;
  submittedAt: number | null;
  observedAt: number | null;
  stopRequestedAt: number | null;
  releasedAt: number | null;
}

export interface ResourceObservation {
  id: string;
  state: string;
  launchToken?: string;
  terminal: boolean;
  stopping: boolean;
  tags: Record<string, string>;
  createdAt: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  containers: Array<{ name: string; exit_code: number | null }>;
}

export interface LaunchIntent {
  token: string;
  runner: string;
  inputs: Record<string, string>;
  deadline: number;
  tags: Record<string, string>;
}
