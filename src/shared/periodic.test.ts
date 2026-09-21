import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPeriodicTask } from './periodic.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startPeriodicTask', () => {
  it('runs immediately and then waits the interval after each completion', async () => {
    const run = vi.fn(async () => {});
    const handle = startPeriodicTask({ run, intervalMs: () => 1_000, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('does not start the next run while the previous one is still going', async () => {
    let release: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const handle = startPeriodicTask({ run, intervalMs: () => 100, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('keeps going after a failed run and reports the error', async () => {
    const onError = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValue(undefined);
    const handle = startPeriodicTask({ run, intervalMs: () => 10, onError });

    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'first failed' }));
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('re-reads the interval every time so config reloads apply', async () => {
    let interval = 1_000;
    const run = vi.fn(async () => {});
    const handle = startPeriodicTask({ run, intervalMs: () => interval, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(0);
    interval = 50;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(3);
    handle.stop();
  });

  it('stops scheduling after stop()', async () => {
    const run = vi.fn(async () => {});
    const handle = startPeriodicTask({ run, intervalMs: () => 10, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
