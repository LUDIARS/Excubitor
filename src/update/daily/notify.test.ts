import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, currentDb, openDb } from '../../db/index.js';
import { beginDailyRun, dailyRuns } from './store.js';
import { notifyDailyFailure } from './notify.js';
import { getDiscordNotificationConfig } from '../../secrets/config-store.js';
import { sendDiscordWebhook } from '../../notify/discord-webhook.js';

vi.mock('../../secrets/config-store.js', () => ({ getDiscordNotificationConfig: vi.fn() }));
vi.mock('../../notify/discord-webhook.js', () => ({ sendDiscordWebhook: vi.fn() }));
describe('daily deployment recovery failure notification', () => {
  beforeEach(() => { openDb(':memory:'); vi.clearAllMocks(); });
  afterEach(() => closeDb());
  it('records a critical error even without a notification destination', async () => {
    vi.mocked(getDiscordNotificationConfig).mockReturnValue(null);
    const run = beginDailyRun('2026-10-06', new Date());
    if (!run) throw new Error('run missing');
    await notifyDailyFailure(run, 'Old version also failed to start');
    expect(currentDb().prepare('SELECT severity FROM error_tasks').get()).toEqual({ severity: 'critical' });
    expect(dailyRuns()[0]?.notification).toContain('not configured');
    expect(sendDiscordWebhook).not.toHaveBeenCalled();
  });
  it('keeps failure evidence if the external notification fails', async () => {
    vi.mocked(getDiscordNotificationConfig).mockReturnValue({ enabled: true, webhookUrl: 'secret',
      downtimeThresholdSec: 60, notifyRecovery: true, peerAlerts: false });
    vi.mocked(sendDiscordWebhook).mockRejectedValue(new Error('unreachable'));
    const run = beginDailyRun('2026-10-06', new Date());
    if (!run) throw new Error('run missing');
    await notifyDailyFailure(run, 'Recovery failed');
    expect(dailyRuns()[0]?.notification).toContain('delivery failed');
    expect(JSON.stringify(dailyRuns())).not.toContain('secret');
  });
});
