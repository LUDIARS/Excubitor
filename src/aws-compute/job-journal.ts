import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ComputeJob, JobIssue, ReleaseState, ResourceObservation, SubmissionState } from './job-types.js';
import { resolveDeadline, selectRunnerInputs } from './limits.js';
import { ComputeRegistry } from './registry.js';
import type { ComputeTarget, SubmitJob } from './target-schema.js';

interface JobRow {
  id: string; job_id: string; target: string; runner: string; launch_token: string; fingerprint: string; inputs: string | null;
  submission: SubmissionState; release: ReleaseState; resource_id: string | null; observation: string | null;
  issue: JobIssue | null; created_at: number; deadline: number; submitted_at: number | null;
  observed_at: number | null; stop_requested_at: number | null; released_at: number | null;
}

type ReserveError = 'job_conflict' | 'target_not_found' | 'target_busy' | 'runner_not_found' | 'invalid_inputs' | 'deadline_elapsed' | 'credentials_unavailable';
type Reservation = { job: ComputeJob; created: boolean } | { error: ReserveError };

function fromRow(row: JobRow): ComputeJob {
  return {
    id: row.id, jobId: row.job_id, target: JSON.parse(row.target) as ComputeTarget, runner: row.runner, launchToken: row.launch_token,
    inputs: row.inputs ? JSON.parse(row.inputs) as Record<string, string> : null,
    submission: row.submission, release: row.release, resourceId: row.resource_id,
    observation: row.observation ? JSON.parse(row.observation) as ResourceObservation : null,
    issue: row.issue, createdAt: row.created_at, deadline: row.deadline, submittedAt: row.submitted_at,
    observedAt: row.observed_at, stopRequestedAt: row.stop_requested_at, releasedAt: row.released_at,
  };
}

export class JobJournal {
  constructor(private readonly db: Database.Database, private readonly registry: ComputeRegistry) {}

  reserve(input: SubmitJob, now: number, configured: boolean): Reservation {
    const requestedDeadline = Date.parse(input.deadline);
    const sortedInputs = Object.entries(input.inputs).sort(([left], [right]) => left.localeCompare(right));
    const fingerprint = createHash('sha256').update(JSON.stringify([input.target_id, input.runner, sortedInputs, requestedDeadline])).digest('hex');
    return this.db.transaction((): Reservation => {
      const existing = this.db.prepare('SELECT * FROM aws_compute_jobs WHERE job_id = ?').get(input.job_id) as JobRow | undefined;
      if (existing) return existing.fingerprint === fingerprint ? { job: fromRow(existing), created: false } : { error: 'job_conflict' };
      const target = this.registry.get(input.target_id);
      if (!target) return { error: 'target_not_found' };
      if (!configured) return { error: 'credentials_unavailable' };
      const runner = target.runners.find(({ id }) => id === input.runner);
      if (!runner) return { error: 'runner_not_found' };
      const inputs = selectRunnerInputs(runner.inputKeys, input.inputs);
      if (!inputs) return { error: 'invalid_inputs' };
      const deadline = resolveDeadline(requestedDeadline, now, target.maxRuntimeSeconds);
      if (deadline === null) return { error: 'deadline_elapsed' };
      if (this.db.prepare(`SELECT 1 FROM aws_compute_jobs WHERE target_id = ? AND release IN ('pending', 'requested')`).get(target.id)) {
        return { error: 'target_busy' };
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO aws_compute_jobs (
        id, job_id, target_id, target, runner, launch_token, fingerprint, inputs, submission, release, created_at, deadline, next_check_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'pending', ?, ?, ?)`)
        .run(id, input.job_id, target.id, JSON.stringify(target), input.runner, randomUUID(), fingerprint, JSON.stringify(inputs), now, deadline, now);
      return { job: this.get(id)!, created: true };
    }).immediate();
  }

  get(id: string): ComputeJob | null {
    const row = this.db.prepare('SELECT * FROM aws_compute_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(active: boolean, limit: number, offset: number): ComputeJob[] {
    const filter = active ? "WHERE release IN ('pending', 'requested')" : '';
    const rows = this.db.prepare(`SELECT * FROM aws_compute_jobs ${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as JobRow[];
    return rows.map(fromRow);
  }

  takeDue(now: number, retryAt: number, allowLaunch: boolean): ComputeJob | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM aws_compute_jobs
        WHERE release IN ('pending', 'requested')
          AND (next_check_at <= @now OR (release = 'pending' AND deadline <= @now))
          AND (@allowLaunch OR submission <> 'queued' OR release = 'requested' OR deadline <= @now)
        ORDER BY CASE WHEN release = 'requested' OR deadline <= @now THEN 0
          WHEN submission = 'queued' THEN 2 ELSE 1 END, next_check_at, created_at LIMIT 1`)
        .get({ now, allowLaunch: allowLaunch ? 1 : 0 }) as JobRow | undefined;
      if (!row) return null;
      this.db.prepare('UPDATE aws_compute_jobs SET next_check_at = ? WHERE id = ?').run(retryAt, row.id);
      return fromRow(row);
    }).immediate();
  }

  claimLaunch(id: string, now: number): boolean {
    return this.db.prepare(`UPDATE aws_compute_jobs SET submission = 'submitting', submitted_at = ?, inputs = NULL
      WHERE id = ? AND submission = 'queued' AND stop_requested_at IS NULL AND deadline > ?`)
      .run(now, id, now).changes === 1;
  }

  finishWithoutResource(id: string, submission: 'rejected' | 'discarded', issue: JobIssue, now: number): void {
    this.db.prepare(`UPDATE aws_compute_jobs SET submission = ?, release = 'not_allocated', inputs = NULL, issue = ?, released_at = ?
      WHERE id = ? AND resource_id IS NULL AND submission IN ('queued', 'submitting')`)
      .run(submission, issue, now, id);
  }

  launchUnconfirmed(id: string): void {
    this.db.prepare(`UPDATE aws_compute_jobs SET submission = 'unknown', issue = 'launch_unconfirmed'
      WHERE id = ? AND submission = 'submitting' AND resource_id IS NULL`).run(id);
  }

  launched(id: string, resourceId: string, now: number): void {
    this.db.prepare(`UPDATE aws_compute_jobs SET submission = 'accepted', resource_id = ?, issue = NULL, next_check_at = ?
      WHERE id = ? AND submission IN ('submitting', 'unknown') AND resource_id IS NULL`).run(resourceId, now, id);
  }

  requestStop(id: string, now: number): ComputeJob | null {
    this.db.prepare(`UPDATE aws_compute_jobs SET release = 'requested', stop_requested_at = ?, next_check_at = ?
      WHERE id = ? AND release = 'pending'`).run(now, now, id);
    return this.get(id);
  }

  observed(id: string, observation: ResourceObservation, now: number): void {
    this.db.prepare(`UPDATE aws_compute_jobs SET submission = 'accepted', resource_id = @resource,
      observation = @observation, observed_at = @now, issue = NULL,
      release = CASE WHEN @terminal THEN 'confirmed' ELSE release END,
      released_at = CASE WHEN @terminal THEN @now ELSE released_at END
      WHERE id = @id AND release IN ('pending', 'requested') AND submission IN ('submitting', 'unknown', 'accepted')
        AND (resource_id IS NULL OR resource_id = @resource)`).run({
      id, resource: observation.id, observation: JSON.stringify(observation), now, terminal: observation.terminal ? 1 : 0,
    });
  }

  issue(id: string, issue: JobIssue): void {
    this.db.prepare(`UPDATE aws_compute_jobs SET issue = ? WHERE id = ? AND release IN ('pending', 'requested')`).run(issue, id);
  }
}
