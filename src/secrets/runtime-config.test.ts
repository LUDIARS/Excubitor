import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfigRouter } from './router.js';

const ORIGINAL_ENV = { ...process.env };

describe('service runtime config API', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'excubitor-runtime-config-'));
    process.env = {
      ...ORIGINAL_ENV,
      EXCUBITOR_CONFIG_PATH: join(tempDir, 'config.enc'),
      EXCUBITOR_MASTER_KEY: 'runtime-config-test-master-key',
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('encrypts the saved payload and never returns its values from the API', async () => {
    const app = buildConfigRouter();
    const privatePath = 'C:\\Users\\person\\private-data';
    const saved = await app.request('/api/v1/config/services/genius/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          dataDir: privatePath,
          embedding: { model: 'bge-m3' },
          sources: { memoryDir: privatePath },
        },
      }),
    });

    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as Record<string, unknown>;
    expect(JSON.stringify(savedBody)).not.toContain(privatePath);
    expect(savedBody).not.toHaveProperty('runtime_config.storePath');
    expect(readFileSync(process.env.EXCUBITOR_CONFIG_PATH!, 'utf8')).not.toContain(privatePath);

    const status = await app.request('/api/v1/config/services/genius/runtime-config');
    const statusBody = await status.json() as Record<string, unknown>;
    expect(statusBody).toMatchObject({
      code: 'genius',
      runtime_config: {
        configured: true,
        keys: ['dataDir', 'embedding', 'sources'],
      },
    });
    expect(statusBody).not.toHaveProperty('runtime_config.storePath');
  });

  it('isolates saved configuration by service code', async () => {
    const app = buildConfigRouter();
    await app.request('/api/v1/config/services/genius/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { dataDir: './data' } }),
    });

    const otherService = await app.request('/api/v1/config/services/aedilis/runtime-config');

    expect(await otherService.json()).toMatchObject({
      code: 'aedilis',
      runtime_config: { configured: false, keys: [] },
    });
  });

  it('clears a service runtime configuration with null', async () => {
    const app = buildConfigRouter();
    await app.request('/api/v1/config/services/genius/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { dataDir: './data' } }),
    });

    const cleared = await app.request('/api/v1/config/services/genius/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: null }),
    });

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      runtime_config: { configured: false, keys: [] },
    });
  });

  it('rejects a non-object runtime configuration', async () => {
    const app = buildConfigRouter();
    const response = await app.request('/api/v1/config/services/genius/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: ['not', 'an', 'object'] }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects ambiguous service codes instead of trimming them', async () => {
    const app = buildConfigRouter();
    const response = await app.request('/api/v1/config/services/%20genius%20/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { dataDir: './data' } }),
    });

    expect(response.status).toBe(400);
  });

  it('does not expose the local store path when persistence fails', async () => {
    process.env.EXCUBITOR_CONFIG_PATH = tempDir;
    const app = buildConfigRouter();
    const response = await app.request('/api/v1/config/services/genius/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { dataDir: './data' } }),
    });

    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ error: 'runtime_config_save_failed' });
    expect(JSON.stringify(body)).not.toContain(tempDir);
  });
});
