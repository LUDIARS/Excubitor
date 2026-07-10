import { describe, expect, it, vi } from 'vitest';
import { publish, subscribe } from './bus.js';
import { recentLogLines, resetLogRingBufferForTests } from './ring-buffer.js';

describe('log bus', () => {
  it('DB を開かずにリングと購読者へ配信する', async () => {
    resetLogRingBufferForTests();
    const subscriber = vi.fn();
    const unsubscribe = subscribe(subscriber);
    try {
      await publish({ service_code: 'svc', channel: 'stdout', ts: new Date(1234), line: 'ready' });
    } finally {
      unsubscribe();
    }

    expect(subscriber).toHaveBeenCalledOnce();
    expect(recentLogLines({ limit: 1 })[0]).toMatchObject({ code: 'svc', ts: 1234, line: 'ready' });
  });
});
