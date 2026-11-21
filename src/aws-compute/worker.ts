import { isDefiniteLaunchRejection } from './aws-protocol.js';
import { nextJobAction } from './job-action.js';
import type { JobJournal } from './job-journal.js';
import type { ComputeJob } from './job-types.js';
import type { ComputeProvider, ProviderFactory } from './provider.js';
import { jobTags, matchesJobTags } from './resource-tags.js';

const OBSERVATION_INTERVAL = 15_000;

export class ComputeWorker {
  constructor(
    private readonly journal: JobJournal,
    private readonly provider: ProviderFactory,
    private readonly owner: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async step(allowLaunch: () => boolean): Promise<void> {
    const now = this.now();
    const job = this.journal.takeDue(now, now + OBSERVATION_INTERVAL, allowLaunch());
    if (!job) return;
    const action = nextJobAction(job, now);
    if (action === 'none') return;
    if (action === 'discard') {
      this.discard(job);
      return;
    }
    if (job.deadline <= now && job.release === 'pending') this.journal.requestStop(job.id, now);

    let provider: ComputeProvider;
    try {
      provider = await this.provider(job.target);
    } catch {
      // No RunInstances or RunTask can have been sent by this step.
      if (action === 'launch') this.journal.finishWithoutResource(job.id, 'rejected', 'credentials_unavailable', this.now());
      else this.journal.issue(job.id, 'credentials_unavailable');
      return;
    }
    const owner = this.owner();
    if (action === 'launch') await this.launch(job, owner, provider, allowLaunch);
    else await this.inspect(job, owner, provider);
  }

  private discard(job: ComputeJob): void {
    const issue = job.stopRequestedAt === null ? 'deadline_elapsed' : 'cancelled_before_submit';
    this.journal.finishWithoutResource(job.id, 'discarded', issue, this.now());
  }

  private async launch(job: ComputeJob, owner: string, provider: ComputeProvider, allowLaunch: () => boolean): Promise<void> {
    let dispatch: () => Promise<string>;
    try {
      if (!job.inputs) throw new Error('queued_inputs_missing');
      dispatch = await provider.prepare({
        token: job.launchToken, runner: job.runner, inputs: job.inputs, deadline: job.deadline, tags: jobTags(job, owner),
      });
    } catch {
      // Preparation performs read-only configuration checks, before the launch is claimed.
      this.journal.finishWithoutResource(job.id, 'rejected', 'invalid_runner_configuration', this.now());
      return;
    }
    if (!allowLaunch() || !this.journal.claimLaunch(job.id, this.now())) return;
    let resourceId: string;
    try {
      resourceId = await dispatch();
    } catch (error) {
      if (isDefiniteLaunchRejection(error)) this.journal.finishWithoutResource(job.id, 'rejected', 'launch_rejected', this.now());
      else this.journal.launchUnconfirmed(job.id);
      return;
    }
    this.journal.launched(job.id, resourceId, this.now());
  }

  private async inspect(job: ComputeJob, owner: string, provider: ComputeProvider): Promise<void> {
    // A restarted process can see 'submitting'. Leaving that state must never dispatch another launch.
    this.journal.launchUnconfirmed(job.id);
    let resource;
    try {
      resource = job.resourceId
        ? await provider.describe(job.resourceId)
        : await provider.reconcile(job.launchToken, jobTags(job, owner));
    } catch {
      this.journal.issue(job.id, 'observation_failed');
      return;
    }
    if (!resource) {
      this.journal.issue(job.id, 'resource_not_visible');
      return;
    }
    if ((job.resourceId !== null && job.resourceId !== resource.id) || !matchesJobTags(resource.tags, job, owner)) {
      this.journal.issue(job.id, 'resource_mismatch');
      return;
    }
    const now = this.now();
    this.journal.observed(job.id, resource, now);
    if (resource.terminal || resource.stopping) return;
    const current = this.journal.get(job.id);
    if (current?.resourceId !== resource.id || current.release === 'confirmed') return;
    const ec2Stopped = job.target.kind === 'ec2' && ['stopping', 'stopped'].includes(resource.state);
    if (current.release !== 'requested' && current.deadline > now && !ec2Stopped) return;
    this.journal.requestStop(job.id, now);
    try {
      await provider.stop(resource.id);
    } catch {
      this.journal.issue(job.id, 'release_failed');
    }
    // The next Describe call, never a successful Stop response, confirms release.
  }
}
