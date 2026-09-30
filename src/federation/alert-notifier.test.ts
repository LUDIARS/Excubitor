import { describe, expect, it, vi } from 'vitest';
import { createAlertStateStore, notifyAlerts, type AlertObservation } from './alert-notifier.js';
import type { NodeResourceAlert } from './health-types.js';

const DOWN_AFTER = 300_000;

function disk(level: NodeResourceAlert['level']): NodeResourceAlert {
  return { key: 'disk:/', kind: 'disk', level, message: 'ストレージ残り', value_pct: 4, threshold_pct: 5, since: 0 };
}

function observe(partial: Partial<AlertObservation>): AlertObservation {
  return { id: 'mac', node: 'kaoimac', status: 'up', error: null, alerts: [], ...partial };
}

describe('notifyAlerts', () => {
  it('reports an unresponsive node once after the grace period and again when it recovers', async () => {
    const store = createAlertStateStore();
    const send = vi.fn(async (_text: string) => undefined);
    const down = observe({ status: 'down', error: 'timeout', alerts: undefined });

    await notifyAlerts(store, [down], 0, { peerDownAfterMs: DOWN_AFTER, send });
    await notifyAlerts(store, [down], DOWN_AFTER - 1, { peerDownAfterMs: DOWN_AFTER, send });
    expect(send).not.toHaveBeenCalled();

    await notifyAlerts(store, [down], DOWN_AFTER, { peerDownAfterMs: DOWN_AFTER, send });
    await notifyAlerts(store, [down], DOWN_AFTER * 2, { peerDownAfterMs: DOWN_AFTER, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatch(/応答しません: kaoimac[\s\S]*timeout/);

    await notifyAlerts(store, [observe({})], DOWN_AFTER * 3, { peerDownAfterMs: DOWN_AFTER, send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatch(/応答を再開: kaoimac/);
  });

  it('does not announce recovery for a blip shorter than the grace period', async () => {
    const store = createAlertStateStore();
    const send = vi.fn(async (_text: string) => undefined);
    await notifyAlerts(store, [observe({ status: 'down', alerts: undefined })], 0, { peerDownAfterMs: DOWN_AFTER, send });
    await notifyAlerts(store, [observe({})], 60_000, { peerDownAfterMs: DOWN_AFTER, send });
    expect(send).not.toHaveBeenCalled();
  });

  it('announces a resource alert once, escalation to critical, and its resolution', async () => {
    const store = createAlertStateStore();
    const send = vi.fn(async (_text: string) => undefined);
    const options = { peerDownAfterMs: DOWN_AFTER, send };

    await notifyAlerts(store, [observe({ alerts: [disk('warn')] })], 0, options);
    await notifyAlerts(store, [observe({ alerts: [disk('warn')] })], 1, options);
    await notifyAlerts(store, [observe({ alerts: [disk('critical')] })], 2, options);
    await notifyAlerts(store, [observe({ alerts: [] })], 3, options);

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/資源アラート: kaoimac\*\*\n- \[warn\]/),
      expect.stringMatching(/- \[critical\]/),
      expect.stringMatching(/資源アラート解消: kaoimac\*\* \(ストレージ \/\)/),
    ]);
  });

  it('keeps alert state while the node is unreachable instead of reporting a resolution', async () => {
    const store = createAlertStateStore();
    const send = vi.fn(async (_text: string) => undefined);
    const options = { peerDownAfterMs: DOWN_AFTER, send };
    await notifyAlerts(store, [observe({ alerts: [disk('warn')] })], 0, options);
    await notifyAlerts(store, [observe({ status: 'down', alerts: undefined })], 1, options);
    await notifyAlerts(store, [observe({ alerts: [disk('warn')] })], 2, options);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a notification whose delivery failed', async () => {
    const store = createAlertStateStore();
    const send = vi.fn(async (_text: string) => undefined).mockRejectedValueOnce(new Error('HTTP 500'));
    const options = { peerDownAfterMs: DOWN_AFTER, send };
    await expect(notifyAlerts(store, [observe({ alerts: [disk('warn')] })], 0, options)).rejects.toThrow('HTTP 500');
    await notifyAlerts(store, [observe({ alerts: [disk('warn')] })], 1, options);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ignores nodes that have not been polled yet', async () => {
    const store = createAlertStateStore();
    const send = vi.fn(async (_text: string) => undefined);
    await notifyAlerts(store, [observe({ status: 'pending', alerts: undefined })], DOWN_AFTER * 10, { peerDownAfterMs: DOWN_AFTER, send });
    expect(send).not.toHaveBeenCalled();
  });
});
