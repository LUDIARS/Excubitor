/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import type { Service } from '../../catalog/loader.js';
import type { DailyRun, RepositoryCheckpoint } from './types.js';
import type { DailyRepository } from './repositories.js';
import { assertExpectedRepository, prepareRepository } from './repositories.js';
import { dailyCommand } from './command.js';
import { buildDailyRepository } from './build.js';
import { saveDailyRun } from './store.js';
import { waitDailyHealthy, type DailyRuntime } from './runtime.js';

export interface DailyTransactionDeps {
  runtime: DailyRuntime;
  build?: typeof buildDailyRepository;
  command?: typeof dailyCommand;
  prepare?: typeof prepareRepository;
  assertExpected?: typeof assertExpectedRepository;
  save?: typeof saveDailyRun;
  waitHealthy?: typeof waitDailyHealthy;
}
/** Repository transaction, including recovery from every persisted side-effect boundary. */
export class DailyRepositoryTransaction {
  private readonly build;
  private readonly command;
  private readonly prepare;
  private readonly assertExpected;
  private readonly save;
  private readonly waitHealthy;
  constructor(private readonly deps: DailyTransactionDeps) {
    this.build = deps.build ?? buildDailyRepository;
    this.command = deps.command ?? dailyCommand;
    this.prepare = deps.prepare ?? prepareRepository;
    this.assertExpected = deps.assertExpected ?? assertExpectedRepository;
    this.save = deps.save ?? saveDailyRun;
    this.waitHealthy = deps.waitHealthy ?? waitDailyHealthy;
  }
  async update(repository: DailyRepository, run: DailyRun): Promise<void> {
    const prepared = await this.prepare(repository.path);
    if (prepared.before === prepared.after) {
      run.events.push({ repository: repository.path, status: 'unchanged', detail: 'Already current' });
      this.save(run); return;
    }
    const running: string[] = [];
    for (const svc of repository.services) if (await this.deps.runtime.running(svc)) running.push(svc.code);
    const checkpoint: RepositoryCheckpoint = { ...prepared, path: repository.path, services: repository.services, running, phase: 'prepared' };
    run.checkpoint = checkpoint;
    this.save(run);
    try {
      this.phase(run, 'stopping');
      await this.stop(checkpoint.services.filter((svc) => running.includes(svc.code)));
      await this.assertExpected(checkpoint.path, checkpoint.branch, [checkpoint.before]);
      this.phase(run, 'updating');
      await this.command('git', ['merge', '--ff-only', checkpoint.after], checkpoint.path);
      await this.submodules(checkpoint.path);
      const catalog = await this.deps.runtime.catalog();
      const services = checkpoint.services.map((svc) => {
        const updated = catalog.services.find((item) => item.code === svc.code);
        if (!updated || updated.disabled && running.includes(svc.code)) throw new Error(`updated service unavailable: ${svc.code}`);
        // A moved service would mutate a second repository outside this transaction.
        if (updated.cwd !== svc.cwd || updated.compose_file !== svc.compose_file || updated.runtime !== svc.runtime) throw new Error(`service deployment location changed: ${svc.code}`);
        return updated;
      });
      this.phase(run, 'building');
      if (services.length) await this.build(checkpoint.path, services);
      await this.assertExpected(checkpoint.path, checkpoint.branch, [checkpoint.after]);
      this.phase(run, 'starting');
      await this.start(services.filter((svc) => running.includes(svc.code)));
      run.events.push({ repository: checkpoint.path, status: 'updated', detail: `${checkpoint.before} -> ${checkpoint.after}` });
      if (services.some((svc) => svc.code === 'excubitor')) {
        run.events.push({ repository: checkpoint.path, status: 'supervisor-restart-required',
          detail: 'Backend and viewer updated. The recovery supervisor remains at its running version until the installed OS service is restarted.' });
      }
      run.checkpoint = null;
      this.save(run);
    } catch (error) {
      run.events.push({ repository: checkpoint.path, status: 'update-failed', detail: message(error) });
      this.save(run);
      await this.rollback(run);
    }
  }
  async rollback(run: DailyRun): Promise<void> {
    const checkpoint = run.checkpoint;
    if (!checkpoint) return;
    this.phase(run, 'rollback');
    const live = checkpoint.services.filter((svc) => checkpoint.running.includes(svc.code));
    await this.stop(live);
    await this.assertExpected(checkpoint.path, checkpoint.branch, [checkpoint.before, checkpoint.after]);
    await this.command('git', ['reset', '--keep', checkpoint.before], checkpoint.path);
    await this.submodules(checkpoint.path);
    // Reload global env/registry from the restored catalog; start with captured old service definitions.
    await this.deps.runtime.catalog();
    if (checkpoint.services.length) await this.build(checkpoint.path, checkpoint.services);
    try { await this.start(live); }
    catch (error) {
      await this.stop(live);
      throw error;
    }
    run.events.push({ repository: checkpoint.path, status: 'rolled-back', detail: checkpoint.before });
    run.checkpoint = null;
    this.save(run);
  }
  private phase(run: DailyRun, phase: RepositoryCheckpoint['phase']): void {
    if (run.checkpoint) run.checkpoint.phase = phase;
    this.save(run);
  }
  private async submodules(path: string): Promise<void> {
    await this.command('git', ['submodule', 'sync', '--recursive'], path, 180_000);
    await this.command('git', ['submodule', 'update', '--init', '--recursive'], path, 600_000);
  }
  private async stop(services: Service[]): Promise<void> {
    // Try all stops before propagating failure so one failed service does not leave siblings running.
    const results = await Promise.allSettled(services.map((svc) => this.deps.runtime.stop(svc)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  private async start(services: Service[]): Promise<void> {
    for (const svc of services) await this.deps.runtime.start(svc);
    if (services.length) await this.waitHealthy(services, this.deps.runtime);
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'Unknown update error'; }
