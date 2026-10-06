/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { Hono } from 'hono';
import { dailyRuns, readDailySettings, saveDailySettings, retryDailyRecovery } from './store.js';
import { DailySettingsSchema } from './types.js';

/** Local administration only. Every site stores its own setting, never in a shared git catalog. */
export function buildDailyUpdateRouter(): Hono {
  const app = new Hono();
  app.post('/api/v1/daily-update/runs/:id/recover', (c) => retryDailyRecovery(c.req.param('id'))
    ? c.json({ accepted: true }, 202) : c.json({ error: 'recovery_unavailable_or_busy' }, 409));
  app.get('/api/v1/daily-update', (c) => c.json({ settings: readDailySettings(), runs: dailyRuns().map(({ checkpoint, ...run }) => ({
    ...run, recoveryPending: checkpoint !== null,
  })) }));
  app.put('/api/v1/daily-update', async (c) => {
    const parsed = DailySettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_settings', detail: parsed.error.flatten() }, 400);
    if (parsed.data.enabled && dailyRuns().some((run) => run.status === 'failed' && run.checkpoint)) {
      return c.json({ error: 'recovery_requires_attention', detail: 'Restore the affected service before enabling automatic updates' }, 409);
    }
    return c.json({ settings: saveDailySettings(parsed.data) });
  });
  return app;
}
