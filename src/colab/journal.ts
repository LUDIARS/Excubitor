import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { admitColabJob, colabFingerprint } from './admission.js';
import type { ColabProgram } from './config.js';
import type { ColabArtifact, ColabSubmit } from './protocol.js';

export interface CliIdentity { cliPath: string; jobRoot: string; osUser: string }
export type Phase = 'accepted' | 'allocating' | 'executing' | 'collecting' | 'releasing' | 'release_unknown' | 'released';
export type Outcome = 'completed' | 'failed' | 'unknown' | 'cancelled' | 'deadline' | 'interrupted';
export type StopReason = Extract<Outcome, 'cancelled' | 'deadline' | 'interrupted'>;

export interface ColabJob {
  id: string;
  fingerprint: string;
  request: ColabSubmit;
  cli: CliIdentity;
  program: ColabProgram;
  phase: Phase;
  createdAt: number;
  deadlineAt: number;
  endpoint: string | null;
  allocationAttempted: boolean;
  stopReason: StopReason | null;
  outcome: Outcome | null;
  files: ColabArtifact[];
  events: { at: number; phase: Phase }[];
}

export function colabReceipt(job: ColabJob) {
  return {
    id: job.id, programId: job.request.programId, sourceRevision: job.request.sourceRevision,
    gpu: job.request.gpu, phase: job.phase, outcome: job.outcome, stopReason: job.stopReason,
    createdAt: job.createdAt, deadlineAt: job.deadlineAt, files: job.files, events: job.events,
  };
}

export type Reservation =
  | { kind: 'existing' | 'created'; job: ColabJob }
  | { kind: 'conflict' | 'busy' };

export class ColabJournal {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS colab_site_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        state TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS colab_site_single_active ON colab_site_jobs(active) WHERE active = 1;
    `);
  }

  get(id: string): ColabJob | undefined {
    return this.read('SELECT state FROM colab_site_jobs WHERE id = ?', id);
  }

  active(): ColabJob | undefined {
    return this.read('SELECT state FROM colab_site_jobs WHERE active = 1');
  }

  byKey(key: string): ColabJob | undefined {
    return this.read('SELECT state FROM colab_site_jobs WHERE idempotency_key = ?', key);
  }

  reserve(input: { request: ColabSubmit; cli: CliIdentity; program: ColabProgram; now: number; deadlineAt: number }): Reservation {
    const { request, cli, program, now, deadlineAt } = input;
    const fingerprint = colabFingerprint(request);
    return this.db.transaction((): Reservation => {
      const existing = this.byKey(request.idempotencyKey);
      const decision = admitColabJob({ existing, fingerprint, busy: this.active() !== undefined });
      if (existing && decision.kind === 'existing') return { kind: 'existing', job: existing };
      if (decision.kind !== 'created') return { kind: decision.kind === 'busy' ? 'busy' : 'conflict' };
      const job: ColabJob = {
        id: randomUUID(), fingerprint, request, cli, program, phase: 'accepted',
        createdAt: now, deadlineAt, endpoint: null, allocationAttempted: false,
        stopReason: null, outcome: null, files: [], events: [{ at: now, phase: 'accepted' }],
      };
      this.db.prepare('INSERT INTO colab_site_jobs (id, idempotency_key, active, state) VALUES (?, ?, 1, ?)')
        .run(job.id, request.idempotencyKey, JSON.stringify(job));
      return { kind: 'created', job };
    }).immediate();
  }

  update(id: string, changes: Partial<Pick<ColabJob, 'phase' | 'endpoint' | 'allocationAttempted' | 'stopReason' | 'outcome' | 'files'>>, now: number): ColabJob {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (!job) throw new Error('colab_job_missing');
      if (job.phase === 'released') return job;
      if (changes.phase && changes.phase !== job.phase &&
          !(job.phase === 'release_unknown' && changes.phase === 'releasing')) {
        job.events.push({ at: now, phase: changes.phase });
      }
      // A cleanup retry retains its unknown phase until the provider confirms absence.
      if (job.phase === 'release_unknown' && changes.phase === 'releasing') return job;
      const next = { ...job, ...changes };
      this.db.prepare('UPDATE colab_site_jobs SET active = ?, state = ? WHERE id = ?')
        .run(next.phase === 'released' ? 0 : 1, JSON.stringify(next), id);
      return next;
    }).immediate();
  }

  private read(sql: string, ...params: string[]): ColabJob | undefined {
    const row = this.db.prepare(sql).get(...params) as { state: string } | undefined;
    return row ? JSON.parse(row.state) as ColabJob : undefined;
  }
}
