/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import type { DailyRuntime } from './runtime.js';
import { DailyRepositoryTransaction } from './transaction.js';
import { activeDailyRun, beginDailyRun, readDailySettings, saveDailyRun, saveDailySettings } from './store.js';
import { dueDailyDate } from './schedule.js';
import { dailyRepositories } from './repositories.js';
import { notifyDailyFailure } from './notify.js';
import { createNamedLogger } from '../../shared/logger.js';
import { detectSafeMode } from '../../safe-mode.js';
import type { DailyRun } from './types.js';

const logger = createNamedLogger('excubitor.daily-update');
interface SchedulerOptions {
  root: string;
  selfRoot: string;
  runtime: DailyRuntime;
  drainControls: () => Promise<void>;
  now?: () => Date;
}
export class DailyUpdateScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private closing = false;
  private readonly transaction: DailyRepositoryTransaction;
  constructor(private readonly options: SchedulerOptions) {
    this.transaction = new DailyRepositoryTransaction({ runtime: options.runtime });
  }
  async start(): Promise<void> {
    if (this.timer) return;
    // Recovery is mandatory even when the option was disabled during the interrupted run.
    const interrupted = activeDailyRun();
    if (interrupted && !detectSafeMode()) await this.recover(interrupted);
    if (this.closing) return;
    this.timer = setInterval(() => this.kick(), 30_000);
    this.timer.unref();
    this.kick();
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active) await this.active;
  }
  private kick(): void {
    if (this.closing || this.active || detectSafeMode()) return;
    this.active = this.tick().catch((error: unknown) => {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'daily update scheduler failed');
    }).finally(() => { this.active = null; });
  }
  private async tick(): Promise<void> {
    const pendingRecovery = activeDailyRun();
    if (pendingRecovery) { await this.recover(pendingRecovery); return; }
    const now = this.options.now?.() ?? new Date();
    const day = dueDailyDate(readDailySettings(), now);
    if (!day) return;
    const run = beginDailyRun(day, now);
    if (!run) return;
    try {
      await this.options.drainControls();
      const catalog = await this.options.runtime.catalog();
      const repositories = await dailyRepositories(this.options.root, catalog.services, this.options.selfRoot);
      for (const repository of repositories) {
        if (this.closing) break;
        try { await this.transaction.update(repository, run); }
        catch (error) {
          const detail = error instanceof Error ? error.message : 'Update failed';
          if (run.checkpoint) {
            await this.failRecovery(run, detail);
            return;
          }
          run.events.push({ repository: repository.path, status: 'skipped', detail });
          saveDailyRun(run);
        }
      }
      if (this.closing) run.events.push({ repository: '', status: 'interrupted', detail: 'Supervisor is stopping; remaining repositories not updated' });
      this.finish(run);
    } catch (error) {
      run.events.push({ repository: '', status: 'failed', detail: error instanceof Error ? error.message : 'Daily update failed' });
      if (run.checkpoint) await this.recover(run);
      else this.finish(run);
    }
  }
  private async recover(run: DailyRun): Promise<void> {
    try {
      await this.options.drainControls();
      await this.transaction.rollback(run);
      run.events.push({ repository: '', status: 'interrupted', detail: 'Interrupted daily run recovered; remaining repositories not updated' });
      this.finish(run);
    } catch (error) {
      await this.failRecovery(run, error instanceof Error ? error.message : 'Recovery failed');
    }
  }
  private async failRecovery(run: DailyRun, detail: string): Promise<void> {
    saveDailySettings({ ...readDailySettings(), enabled: false });
    run.events.push({ repository: run.checkpoint?.path ?? '', status: 'recovery-failed', detail });
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    saveDailyRun(run);
    await notifyDailyFailure(run, detail);
  }
  private finish(run: DailyRun): void {
    run.status = run.events.some((event) => !['updated', 'unchanged'].includes(event.status)) ? 'failed' : 'succeeded';
    run.finishedAt = new Date().toISOString();
    saveDailyRun(run);
  }
}
