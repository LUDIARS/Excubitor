import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, openDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import type { DiscordNotificationConfig } from '../secrets/config-store.js';
import { processDowntimeAlerts } from './downtime-alert.js';
import type { HealthObservation } from './health-state.js';

const CONFIG: DiscordNotificationConfig = {
  webhookUrl: 'https://discord.com/api/webhooks/123/token',
  enabled: true,
  downtimeThresholdSec: 60,
  notifyRecovery: true,
};

const DOWN: HealthObservation = {
  code: 'svc',
  name: 'Service',
  ok: false,
  reason: 'failed',
  detail: 'HTTP 503',
};

describe('downtime alerts', () => {
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

  it('alerts once only after a continuous one-minute outage', async () => {
    const send = vi.fn(async () => undefined);
    await processDowntimeAlerts([DOWN], { now: 1_000, config: CONFIG, send });
    await processDowntimeAlerts([DOWN], { now: 60_999, config: CONFIG, send });
    expect(send).not.toHaveBeenCalled();

    await processDowntimeAlerts([DOWN], { now: 61_000, config: CONFIG, send });
    await processDowntimeAlerts([DOWN], { now: 121_000, config: CONFIG, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls as unknown as Array<[string, string]>)[0]?.[1]).toContain('Service down');
  });

  it('sends one recovery after a notified outage and clears incident state', async () => {
    const send = vi.fn(async () => undefined);
    await processDowntimeAlerts([DOWN], { now: 1_000, config: CONFIG, send });
    await processDowntimeAlerts([DOWN], { now: 61_000, config: CONFIG, send });
    await processDowntimeAlerts([{ ...DOWN, ok: true, reason: 'http', detail: 'HTTP 200' }], {
      now: 92_000,
      config: CONFIG,
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls as unknown as Array<[string, string]>)[1]?.[1]).toContain('Service recovered');
    const state = db().get(sql`
      SELECT down_since, notified_at FROM health_alert_state WHERE service_code = 'svc'
    `) as { down_since: number | null; notified_at: number | null };
    expect(state).toEqual({ down_since: null, notified_at: null });
  });

  it('retains the incident and retries after a webhook failure', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    await processDowntimeAlerts([DOWN], { now: 1_000, config: CONFIG, send });
    await processDowntimeAlerts([DOWN], { now: 61_000, config: CONFIG, send });
    await processDowntimeAlerts([DOWN], { now: 80_000, config: CONFIG, send });
    expect(send).toHaveBeenCalledTimes(1);
    await processDowntimeAlerts([DOWN], { now: 92_000, config: CONFIG, send });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
