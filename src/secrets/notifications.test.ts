import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfigRouter } from './router.js';

const ORIGINAL_ENV = { ...process.env };

describe('Discord notification config API', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'excubitor-notifications-'));
    process.env = {
      ...ORIGINAL_ENV,
      EXCUBITOR_CONFIG_PATH: join(tempDir, 'config.enc'),
      EXCUBITOR_MASTER_KEY: 'notifications-test-master-key',
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores the webhook encrypted and returns status without the URL', async () => {
    const app = buildConfigRouter();
    const webhook = 'https://discord.com/api/webhooks/123/secret-token';
    const saved = await app.request('/api/v1/config/notifications/discord', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhook_url: webhook,
        enabled: true,
        downtime_threshold_sec: 90,
        notify_recovery: true,
      }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as Record<string, unknown>;
    expect(JSON.stringify(savedBody)).not.toContain(webhook);
    expect(readFileSync(process.env.EXCUBITOR_CONFIG_PATH!, 'utf8')).not.toContain('secret-token');

    const status = await app.request('/api/v1/config/notifications');
    expect(await status.json()).toMatchObject({
      discord: {
        configured: true,
        enabled: true,
        source: 'config',
        downtime_threshold_sec: 90,
        notify_recovery: true,
      },
    });
  });

  it('tests the saved webhook without exposing it', async () => {
    const app = buildConfigRouter();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await app.request('/api/v1/config/notifications/discord', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhook_url: 'https://discord.com/api/webhooks/123/secret-token',
        enabled: true,
        downtime_threshold_sec: 60,
        notify_recovery: true,
      }),
    });

    const response = await app.request('/api/v1/config/notifications/discord/test', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: 'Discord webhook test succeeded' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
