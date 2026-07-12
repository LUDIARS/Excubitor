import { describe, expect, it } from 'vitest';
import { TargetOperationQueue } from './target-queue.js';

describe('TargetOperationQueue', () => {
  it('serializes operations for the same target in submission order', async () => {
    const queue = new TargetOperationQueue();
    const events: string[] = [];
    const gate = deferred();
    const started = deferred();

    const first = queue.run('service:a', async () => {
      events.push('first:start');
      started.resolve();
      await gate.promise;
      events.push('first:end');
    });
    const second = queue.run('service:a', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await started.promise;
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('allows different targets to make progress independently', async () => {
    const queue = new TargetOperationQueue();
    const events: string[] = [];
    const gate = deferred();

    const first = queue.run('service:a', async () => {
      events.push('a:start');
      await gate.promise;
      events.push('a:end');
    });
    const second = queue.run('service:b', async () => {
      events.push('b:start');
      events.push('b:end');
    });

    await second;
    expect(events).toEqual(['a:start', 'b:start', 'b:end']);
    gate.resolve();
    await first;
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveValue: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: () => resolveValue?.(),
  };
}
