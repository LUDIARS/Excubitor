import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../../db/index.js';
import { beginDailyRun, saveDailyRun } from './store.js';
import { buildDailyUpdateRouter } from './router.js';
import type { Service } from '../../catalog/loader.js';

describe('per-site daily update API', () => {
  beforeEach(() => { openDb(':memory:'); });
  afterEach(() => closeDb());
  it('validates settings and does not create a run when saving', async () => {
    const app = buildDailyUpdateRouter();
    expect((await app.request('/api/v1/daily-update', { method: 'PUT', body: '{bad' })).status).toBe(400);
    const saved = await app.request('/api/v1/daily-update', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, time: '06:00', timezone: 'Asia/Tokyo' }) });
    expect(saved.status).toBe(200);
    const data = await (await app.request('/api/v1/daily-update')).json() as { settings: { enabled: boolean }; runs: unknown[] };
    expect(data.settings.enabled).toBe(true); expect(data.runs).toEqual([]);
  });
  it('does not expose captured service environment and blocks unattended retries after recovery failure', async () => {
    const run = beginDailyRun('2026-10-06', new Date());
    if (!run) throw new Error('run missing');
    run.status = 'failed';
    run.checkpoint = { path: '/repo', branch: 'main', before: 'old', after: 'new', phase: 'rollback', running: [],
      services: [{ code: 'private', env: { PASSWORD: 'must-not-leak' } } as unknown as Service] };
    saveDailyRun(run);
    const app = buildDailyUpdateRouter();
    expect(await (await app.request('/api/v1/daily-update')).text()).not.toContain('must-not-leak');
    const response = await app.request('/api/v1/daily-update', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, time: '06:00', timezone: 'UTC' }) });
    expect(response.status).toBe(409);
    expect((await app.request(`/api/v1/daily-update/runs/${run.id}/recover`, { method: 'POST' })).status).toBe(202);
    expect((await app.request(`/api/v1/daily-update/runs/${run.id}/recover`, { method: 'POST' })).status).toBe(409);
  });
});
