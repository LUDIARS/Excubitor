import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb } from '../../db/index.js';
import { resetDbClientForTests } from '../../db/client.js';
import type { Catalog } from '../../catalog/loader.js';
import { createOperationRunner, type OperationExecutor } from './runner.js';
import { createOperation, getOperation, listRecentOperations, markRestarting, markRunning } from './store.js';

const catalog = { services: [] } as unknown as Catalog;

beforeEach(() => {
  resetDbClientForTests();
  closeDb();
  resetDbClientForTests();
  openDb(':memory:');
});

afterEach(() => {
  closeDb();
  resetDbClientForTests();
});

const serviceRestart = {
  requestedBy: 'kaoimac',
  requesterPeerId: 'peer-1',
  target: { kind: 'service' as const, code: 'svc-a' },
  action: 'restart' as const,
  source: 'origin' as const,
};

describe('operation runner', () => {
  it('runs queued operations one at a time, in order, and records steps and results', async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const execute: OperationExecutor = async (op, ctx) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(op.id);
      ctx.record({ step: 'restart', ok: op.action === 'restart', detail: 'done' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return op.action === 'restart'
        ? { kind: 'finished', ok: true, error: null }
        : { kind: 'finished', ok: false, error: 'stop failed' };
    };
    const runner = createOperationRunner({ getCatalog: () => catalog, execute, findPeer: () => null });

    const first = runner.enqueue(serviceRestart);
    const second = runner.enqueue({ ...serviceRestart, action: 'stop' });
    await runner.idle();

    expect(peak).toBe(1);
    expect(order).toEqual([first.id, second.id]);
    expect(getOperation(first.id)).toMatchObject({ status: 'succeeded', error: null, last_step: 'restart' });
    expect(getOperation(second.id)).toMatchObject({ status: 'failed', error: 'stop failed' });
    expect(getOperation(first.id)!.steps).toEqual([{ step: 'restart', ok: true, detail: 'done' }]);
  });

  it('passes the requesting peer and an audit actor to the executor', async () => {
    const execute = vi.fn<OperationExecutor>(async () => ({ kind: 'finished', ok: true, error: null }));
    const peer = { id: 'peer-1', name: 'Mac' } as never;
    const runner = createOperationRunner({ getCatalog: () => catalog, execute, findPeer: () => peer });
    runner.enqueue(serviceRestart);
    runner.enqueue({ ...serviceRestart, requestedBy: 'local', requesterPeerId: null });
    await runner.idle();
    expect(execute.mock.calls[0]![1]).toMatchObject({ actor: 'federation:kaoimac', requester: peer });
    expect(execute.mock.calls[1]![1]).toMatchObject({ actor: 'local', requester: null });
  });

  it('turns an executor exception into a failed operation instead of stopping the queue', async () => {
    const execute: OperationExecutor = async (op) => {
      if (op.action === 'stop') throw new Error('boom');
      return { kind: 'finished', ok: true, error: null };
    };
    const runner = createOperationRunner({ getCatalog: () => catalog, execute, findPeer: () => null });
    const broken = runner.enqueue({ ...serviceRestart, action: 'stop' });
    const next = runner.enqueue(serviceRestart);
    await runner.idle();
    expect(getOperation(broken.id)).toMatchObject({ status: 'failed', error: 'unexpected: boom' });
    expect(getOperation(next.id)!.status).toBe('succeeded');
  });

  it('leaves a self restart as restarting and stops draining until the next boot', async () => {
    const execute: OperationExecutor = async (op) => {
      if (op.target.kind === 'excubitor') {
        markRestarting(op.id, { expected_hash: 'abc123' });
        return { kind: 'restarting' };
      }
      return { kind: 'finished', ok: true, error: null };
    };
    const runner = createOperationRunner({ getCatalog: () => catalog, execute, findPeer: () => null });
    const self = runner.enqueue({ ...serviceRestart, target: { kind: 'excubitor' }, action: 'deploy' });
    const after = runner.enqueue(serviceRestart);
    await runner.idle();
    expect(getOperation(self.id)!.status).toBe('restarting');
    expect(getOperation(after.id)!.status).toBe('queued');
  });

  it('settles operations on boot: restart verified by hash, interrupted runs failed, queue resumed', async () => {
    const ok = createOperation({ ...serviceRestart, target: { kind: 'excubitor' }, action: 'deploy', now: 1 });
    markRunning(ok.id, 2);
    markRestarting(ok.id, { expected_hash: 'newhash' });
    const wrong = createOperation({ ...serviceRestart, target: { kind: 'excubitor' }, action: 'restart', now: 3 });
    markRunning(wrong.id, 4);
    markRestarting(wrong.id, { expected_hash: 'otherhash' });
    const interrupted = createOperation({ ...serviceRestart, now: 5 });
    markRunning(interrupted.id, 6);
    const queued = createOperation({ ...serviceRestart, now: 7 });

    const execute = vi.fn<OperationExecutor>(async () => ({ kind: 'finished', ok: true, error: null }));
    const runner = createOperationRunner({ getCatalog: () => catalog, execute, findPeer: () => null });
    runner.recover('newhash');
    await runner.idle();

    expect(getOperation(ok.id)).toMatchObject({ status: 'succeeded', last_step: 'restart' });
    expect(getOperation(wrong.id)).toMatchObject({ status: 'failed' });
    expect(getOperation(wrong.id)!.error).toMatch(/newhash.*otherhash/);
    expect(getOperation(interrupted.id)).toMatchObject({ status: 'failed', last_step: 'interrupted' });
    expect(getOperation(queued.id)!.status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('lists recent operations newest first', () => {
    const a = createOperation({ ...serviceRestart, now: 1 });
    const b = createOperation({ ...serviceRestart, now: 2 });
    expect(listRecentOperations(10).map((o) => o.id)).toEqual([b.id, a.id]);
  });
});
