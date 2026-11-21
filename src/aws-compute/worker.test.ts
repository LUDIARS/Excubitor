import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobJournal } from './job-journal.js';
import type { ComputeJob, ResourceObservation } from './job-types.js';
import { OrphanSweep } from './orphan-sweep.js';
import type { ComputeProvider } from './provider.js';
import { EXPIRY_TAG, jobTags, OWNER_TAG } from './resource-tags.js';
import { ComputeWorker } from './worker.js';
import { createJournalFixture, ec2Target, fakeSubmit, fargateTarget, NOW } from './test-fixtures.js';

const INSTANCE = 'i-0123456789abcdef0';
let fixture: ReturnType<typeof createJournalFixture>;

function reserved(): ComputeJob {
  const entry = fixture.journal.reserve(fakeSubmit, NOW, true);
  if (!('job' in entry)) throw new Error(entry.error);
  return entry.job;
}

function observed(job: ComputeJob, state = 'running'): ResourceObservation {
  return {
    id: INSTANCE, state, terminal: state === 'terminated', stopping: false,
    tags: jobTags(job, fixture.registry.owner()), createdAt: NOW, startedAt: NOW, stoppedAt: null, containers: [],
  };
}

function fakeProvider() {
  const dispatch = vi.fn<() => Promise<string>>().mockResolvedValue(INSTANCE);
  const provider = {
    prepare: vi.fn<ComputeProvider['prepare']>().mockResolvedValue(dispatch),
    reconcile: vi.fn<ComputeProvider['reconcile']>().mockResolvedValue(null),
    describe: vi.fn<ComputeProvider['describe']>().mockResolvedValue(null),
    stop: vi.fn<ComputeProvider['stop']>().mockResolvedValue(undefined),
    inventory: vi.fn<ComputeProvider['inventory']>().mockResolvedValue({ resources: [] }),
  };
  return { provider, dispatch };
}

beforeEach(() => { fixture = createJournalFixture(); });
afterEach(() => { fixture.db.close(); });

describe('AWS compute lifecycle', () => {
  it('write-aheads one launch, caps the deadline, and confirms release by observing termination', async () => {
    const job = reserved();
    const { provider, dispatch } = fakeProvider();
    let now = NOW;
    dispatch.mockImplementationOnce(async () => {
      expect(fixture.journal.get(job.id)).toMatchObject({ submission: 'submitting', launchToken: job.launchToken, inputs: null, submittedAt: NOW });
      return INSTANCE;
    });
    const worker = new ComputeWorker(fixture.journal, async () => provider, () => fixture.registry.owner(), () => now);
    await worker.step(() => true);
    expect(job.launchToken).not.toBe(job.id);
    expect(provider.prepare).toHaveBeenCalledWith(expect.objectContaining({ token: job.launchToken, deadline: NOW + 300_000 }));
    expect(fixture.journal.reserve({ ...fakeSubmit, job_id: 'other' }, now, true)).toEqual({ error: 'target_busy' });
    now = job.deadline;
    provider.describe.mockResolvedValue(observed(job));
    await worker.step(() => true);
    expect(provider.stop).toHaveBeenCalledWith(INSTANCE);
    expect(fixture.journal.get(job.id)).toMatchObject({ release: 'requested', releasedAt: null });
    provider.describe.mockResolvedValue(observed(job, 'terminated'));
    now += 15_000;
    await worker.step(() => true);
    expect(fixture.journal.get(job.id)).toMatchObject({ release: 'confirmed', releasedAt: now });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash between the write-ahead and response without dispatching', async () => {
    const job = reserved();
    expect(fixture.journal.claimLaunch(job.id, NOW)).toBe(true);
    const { provider, dispatch } = fakeProvider();
    provider.reconcile.mockResolvedValue(observed(job));
    const reopened = new JobJournal(fixture.db, fixture.registry);
    const worker = new ComputeWorker(reopened, async () => provider, () => fixture.registry.owner(), () => NOW);
    await worker.step(() => true);
    expect(provider.reconcile).toHaveBeenCalledWith(job.launchToken, jobTags(job, fixture.registry.owner()));
    expect(dispatch).not.toHaveBeenCalled();
    expect(reopened.get(job.id)).toMatchObject({ submission: 'accepted', resourceId: INSTANCE });
  });

  it('retains an unknown outcome on transport loss or disappearance and rejects foreign tags', async () => {
    const job = reserved();
    const { provider, dispatch } = fakeProvider();
    let now = NOW;
    dispatch.mockRejectedValueOnce(new Error('transport lost the receipt'));
    const worker = new ComputeWorker(fixture.journal, async () => provider, () => fixture.registry.owner(), () => now);
    await worker.step(() => true);
    expect(fixture.journal.get(job.id)).toMatchObject({ submission: 'unknown', release: 'pending' });
    now = job.deadline;
    await worker.step(() => true);
    expect(fixture.journal.get(job.id)).toMatchObject({ issue: 'resource_not_visible', release: 'requested' });
    const resource = observed(job);
    provider.reconcile.mockResolvedValue({ ...resource, tags: { ...resource.tags, [OWNER_TAG]: 'other-site' } });
    now += 15_000;
    await worker.step(() => true);
    expect(fixture.journal.get(job.id)?.issue).toBe('resource_mismatch');
    expect(provider.stop).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('cancels before claiming a launch even during provider preparation', async () => {
    const job = reserved();
    const { provider, dispatch } = fakeProvider();
    provider.prepare.mockImplementationOnce(async () => {
      fixture.journal.requestStop(job.id, NOW);
      return dispatch;
    });
    const worker = new ComputeWorker(fixture.journal, async () => provider, () => fixture.registry.owner(), () => NOW);
    await worker.step(() => true);
    await worker.step(() => true);
    expect(fixture.journal.get(job.id)).toMatchObject({ submission: 'discarded', release: 'not_allocated', inputs: null });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a reserved job queued when safe mode starts during preparation', async () => {
    const job = reserved();
    const { provider, dispatch } = fakeProvider();
    let allowLaunch = true;
    provider.prepare.mockImplementationOnce(async () => {
      allowLaunch = false;
      return dispatch;
    });
    const worker = new ComputeWorker(fixture.journal, async () => provider, () => fixture.registry.owner(), () => NOW);
    await worker.step(() => allowLaunch);
    expect(fixture.journal.get(job.id)).toMatchObject({ submission: 'queued', submittedAt: null });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports expired orphans by default and stops only matching owner and target when enabled', async () => {
    const job = reserved();
    fixture.journal.finishWithoutResource(job.id, 'discarded', 'cancelled_before_submit', NOW);
    const local = observed(job);
    const foreign = { ...local, id: 'i-0123456789abcdef1', tags: { ...local.tags, [OWNER_TAG]: 'foreign' } };
    const future = { ...local, id: 'i-0123456789abcdef2', tags: { ...local.tags, [EXPIRY_TAG]: new Date(job.deadline + 1_000).toISOString() } };
    const { provider } = fakeProvider();
    provider.inventory.mockResolvedValue({ resources: [local, foreign, future] });
    const sweep = new OrphanSweep(fixture.registry, fixture.journal, async () => provider, () => job.deadline);
    for await (const _ of sweep.scan(fixture.registry.list())) { /* Drain the inventory pages. */ }
    expect(sweep.report()).toMatchObject({ expired: 1, resources: [{ resource_id: INSTANCE, action: 'reported' }] });
    expect(provider.stop).not.toHaveBeenCalled();
    fixture.registry.put({ ...ec2Target, orphanPolicy: 'terminate' });
    provider.describe.mockResolvedValueOnce({ ...future, id: INSTANCE });
    for await (const _ of sweep.scan(fixture.registry.list())) { /* Drain the inventory pages. */ }
    expect(provider.stop).not.toHaveBeenCalled();
    provider.describe.mockResolvedValue(local);
    for await (const _ of sweep.scan(fixture.registry.list())) { /* Drain the inventory pages. */ }
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.stop).toHaveBeenCalledWith(INSTANCE);
  });

  it('recovers a stopped Fargate task from inventory only when its private token and tags match', async () => {
    fixture.registry.put(fargateTarget);
    const reservation = fixture.journal.reserve({ ...fakeSubmit, target_id: fargateTarget.id }, NOW, true);
    if (!('job' in reservation)) throw new Error(reservation.error);
    const { job } = reservation;
    fixture.journal.claimLaunch(job.id, NOW);
    const { provider } = fakeProvider();
    const task = { ...observed(job), id: 'arn:aws:ecs:us-east-1:123456789012:task/compute/0123456789abcdef0123456789abcdef',
      terminal: true, state: 'STOPPED', launchToken: job.launchToken };
    const sweep = new OrphanSweep(fixture.registry, fixture.journal, async () => provider, () => NOW);
    provider.inventory.mockResolvedValueOnce({ resources: [{ ...task, launchToken: 'another-token' }] });
    for await (const _ of sweep.scan([fargateTarget])) { /* Drain the inventory pages. */ }
    expect(fixture.journal.get(job.id)).toMatchObject({ release: 'pending', resourceId: null });
    provider.inventory.mockResolvedValueOnce({ resources: [task] });
    for await (const _ of sweep.scan([fargateTarget])) { /* Drain the inventory pages. */ }
    expect(fixture.journal.get(job.id)).toMatchObject({ release: 'confirmed', resourceId: task.id });
  });
});
