import { createNamedLogger } from '../shared/logger.js';
import { colabFingerprint } from './admission.js';
import { privateJobRoot, snapshotColabArtifacts, stageColabProgram } from './artifacts.js';
import { authorizeColabStart } from './authorization.js';
import type { ColabCli } from './cli.js';
import type { ColabSiteSettings } from './config.js';
import type { ColabJob, ColabJournal, Outcome, StopReason } from './journal.js';
import type { ColabSubmit } from './protocol.js';
import { releaseConfirmed } from './release.js';

const logger = createNamedLogger('excubitor.colab');
const CLEANUP_INTERVAL_MS = 15_000;
const CLEANUP_BUDGET_MS = 60_000;
type Submission =
  | { job: ColabJob; created: boolean }
  | { error: string; status: 400 | 403 | 409 | 503 };

export class ColabRunner {
  private activeWork?: { id: string; abort: AbortController; promise: Promise<void> };
  private cleanupTimer?: NodeJS.Timeout;
  private closing = false;
  private readiness = false;
  private readinessCheck?: Promise<boolean>;

  constructor(
    private readonly journal: ColabJournal,
    private readonly cli: ColabCli,
    readonly site: ColabSiteSettings | undefined,
    private readonly allowLaunch: () => boolean,
    private readonly now = Date.now,
  ) {}

  startRecovery(): void {
    this.recover();
    this.cleanupTimer = setInterval(() => this.recover(), CLEANUP_INTERVAL_MS).unref();
  }

  get(id: string): ColabJob | undefined { return this.journal.get(id); }
  active(): ColabJob | undefined { return this.journal.active(); }
  get lastReadiness(): boolean { return this.readiness && this.allowLaunch() && !this.closing; }

  ready(): Promise<boolean> {
    this.readinessCheck ??= this.probeReadiness().then(result => {
      this.readiness = result;
      return result;
    }).finally(() => { this.readinessCheck = undefined; });
    return this.readinessCheck;
  }

  private async probeReadiness(): Promise<boolean> {
    const site = this.site;
    if (!site?.enabled || this.closing || !this.allowLaunch()) return false;
    try { return await privateJobRoot(site.jobRoot) && await this.cli.ready(site); }
    catch { return false; }
  }

  async submit(request: ColabSubmit): Promise<Submission> {
    const site = this.site;
    if (!site || !authorizeColabStart({ enabled: site.enabled, ownerId: site.ownerId, request })) {
      return { status: 403, error: 'colab_start_not_allowed' };
    }
    const existing = this.journal.byKey(request.idempotencyKey);
    if (existing) return existing.fingerprint === colabFingerprint(request)
      ? { job: existing, created: false }
      : { status: 409, error: 'colab_idempotency_conflict' };
    if (this.journal.active()) return { status: 409, error: 'colab_site_busy' };
    const program = Object.hasOwn(site.programs, request.programId) ? site.programs[request.programId] : undefined;
    if (!program || program.sourceRevision !== request.sourceRevision ||
        program.sha256 !== request.programSha256 || program.gpu !== request.gpu) {
      return { status: 400, error: 'colab_program_mismatch' };
    }
    if (request.deadlineAt <= this.now()) return { status: 400, error: 'colab_deadline_elapsed' };
    if (!await this.ready() || this.closing || !this.allowLaunch()) {
      return { status: 503, error: 'colab_not_ready' };
    }
    const now = this.now();
    if (request.deadlineAt <= now) return { status: 400, error: 'colab_deadline_elapsed' };
    const { cliPath, jobRoot, osUser } = site;
    const result = this.journal.reserve({
      cli: { cliPath, jobRoot, osUser }, program, request, now,
      deadlineAt: Math.min(request.deadlineAt, now + site.maxRuntimeSeconds * 1000),
    });
    if (!('job' in result)) return { status: 409, error: result.kind === 'busy' ? 'colab_site_busy' : 'colab_idempotency_conflict' };
    if (result.kind === 'created') this.work(result.job, signal => this.execute(result.job, signal));
    return { job: result.job, created: result.kind === 'created' };
  }

  cancel(id: string): ColabJob | undefined {
    const job = this.journal.get(id);
    if (!job || job.phase === 'released') return job;
    const stopped = job.outcome ? job : this.setStopReason(job, 'cancelled');
    if (this.activeWork?.id === id) this.activeWork.abort.abort();
    else this.recover();
    return stopped;
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    const job = this.journal.active();
    if (job) {
      if (!job.outcome) this.setStopReason(job, 'interrupted');
      if (this.activeWork) this.activeWork.abort.abort();
      else this.recover();
    }
    await this.activeWork?.promise;
  }

  private work(job: ColabJob, fn: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => fn(abort.signal))
      .catch(() => { logger.error({ jobId: job.id }, 'Colab lifecycle work failed; recovery will retry release'); })
      .finally(() => { this.activeWork = undefined; });
    this.activeWork = { id: job.id, abort, promise };
  }

  private recover(): void {
    if (this.activeWork) return;
    let job: ColabJob | undefined;
    try { job = this.journal.active(); }
    catch {
      logger.error('Colab journal unavailable during recovery');
      return;
    }
    if (!job) return;
    const interrupted = job;
    this.work(interrupted, async () => {
      const current = this.journal.get(interrupted.id) ?? interrupted;
      const stopped = current.outcome ? current : this.setStopReason(current, current.deadlineAt <= this.now() ? 'deadline' : 'interrupted');
      await this.release(this.journal.update(current.id, { outcome: stopped.outcome ?? stopped.stopReason }, this.now()));
    });
  }

  private async execute(job: ColabJob, stop: AbortSignal): Promise<void> {
    const clock = AbortSignal.timeout(Math.max(0, job.deadlineAt - this.now()));
    const signal = AbortSignal.any([clock, stop]);
    let outcome: Outcome = 'failed';
    try {
      const program = await stageColabProgram(job);
      signal.throwIfAborted();
      if (this.now() >= job.deadlineAt || !this.allowLaunch()) return;

      this.journal.update(job.id, { phase: 'allocating', allocationAttempted: true }, this.now());
      outcome = 'unknown';
      if (!await this.cli.allocate(job, signal)) return;
      const sessions = await this.cli.sessions(job, signal);
      const endpoint = sessions && this.cli.namedEndpoint(job, sessions);
      if (!endpoint || signal.aborted) return;

      this.journal.update(job.id, { phase: 'executing', endpoint }, this.now());
      if (!await this.cli.execute(job, program, signal)) return;
      signal.throwIfAborted();

      outcome = 'failed';
      this.journal.update(job.id, { phase: 'collecting' }, this.now());
      const { files, exitCode } = await snapshotColabArtifacts(job, this.cli, signal);
      signal.throwIfAborted();
      this.journal.update(job.id, { files }, this.now());
      outcome = exitCode === 0 ? 'completed' : 'failed';
    } catch {
      // Child and filesystem output can include credentials, code and host paths.
      // The receipt exposes the journal stage and outcome only.
    } finally {
      let current = this.journal.get(job.id) ?? job;
      if (clock.aborted || this.now() >= job.deadlineAt) current = this.setStopReason(current, 'deadline');
      await this.release(this.journal.update(job.id, { outcome: current.stopReason ?? outcome }, this.now()));
    }
  }

  private setStopReason(job: ColabJob, stopReason: StopReason): ColabJob {
    return job.stopReason ? job : this.journal.update(job.id, { stopReason }, this.now());
  }

  private async release(job: ColabJob): Promise<void> {
    this.journal.update(job.id, { phase: 'releasing' }, this.now());
    if (!job.allocationAttempted) {
      this.journal.update(job.id, { phase: 'released' }, this.now());
      return;
    }
    const signal = AbortSignal.timeout(CLEANUP_BUDGET_MS);
    try {
      let endpoint = job.endpoint;
      if (!endpoint) {
        const before = await this.cli.sessions(job, signal);
        endpoint = before && this.cli.namedEndpoint(job, before);
        if (endpoint) this.journal.update(job.id, { endpoint }, this.now());
      }
      // A known job has its own CLI state file and name. At the deadline stop it
      // before making any potentially slow provider observation.
      await this.cli.stop(job, signal);
      const after = await this.cli.sessions(job, signal);
      if (releaseConfirmed({ endpoint, activeEndpoints: after?.map(session => session.endpoint) ?? null })) {
        this.journal.update(job.id, { phase: 'released' }, this.now());
        return;
      }
    } finally {
      this.journal.update(job.id, { phase: 'release_unknown' }, this.now());
    }
  }
}
