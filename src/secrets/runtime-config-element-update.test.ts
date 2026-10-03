/** @implements SPEC-SERVICE-RUNTIME-CONFIG-ELEMENT-UPDATE */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfigRouter } from './router.js';
import { getServiceRuntimeConfig } from './config-store.js';
import { RuntimeConfigElementUpdateError, updateRuntimeConfigElements } from './runtime-config-element-update.js';

const SECRET = 'shared-secret-value';
const ACTIO = { repoPath: 'E:/Document/Ars/Actio', projectId: 'At', ownerId: 'actio-local', authMode: 'loopback', teamId: null };
const OTHER = { repoPath: 'E:/Document/Ars/Other', projectId: 'Ot', ownerId: 'owner-1', authMode: 'bearer', teamId: 'team-2' };

describe('updateRuntimeConfigElements', () => {
  const config = () => ({ shared: SECRET, bindings: [ACTIO, OTHER] });

  it('sets fields only on elements matching every field and keeps other keys', () => {
    const result = updateRuntimeConfigElements(config(), {
      key: 'bindings', match: { repoPath: ACTIO.repoPath, teamId: null }, set: { teamId: 'team-1' },
    });
    expect(result.matched).toBe(1);
    expect(result.config).toEqual({ shared: SECRET, bindings: [{ ...ACTIO, teamId: 'team-1' }, OTHER] });
  });

  it('treats a null match as null or missing', () => {
    const { teamId: _omit, ...withoutTeam } = ACTIO;
    const result = updateRuntimeConfigElements({ bindings: [withoutTeam] }, {
      key: 'bindings', match: { teamId: null }, set: { teamId: 'team-1' },
    });
    expect(result.matched).toBe(1);
  });

  it('removes matching elements', () => {
    const result = updateRuntimeConfigElements(config(), { key: 'bindings', match: { projectId: 'At' }, remove: true });
    expect(result).toEqual({ matched: 1, config: { shared: SECRET, bindings: [OTHER] } });
  });

  it('returns the original config untouched when nothing matches', () => {
    const current = config();
    const result = updateRuntimeConfigElements(current, { key: 'bindings', match: { projectId: 'none' }, set: { teamId: 'x' } });
    expect(result).toEqual({ matched: 0, config: current });
    expect(result.config).toBe(current);
  });

  it('rejects ambiguous or unsafe requests without echoing values', () => {
    for (const [current, update] of [
      [config(), { key: 'bindings', match: {}, set: { teamId: 'x' } }],
      [config(), { key: 'bindings', match: { projectId: 'At' } }],
      [config(), { key: 'bindings', match: { projectId: 'At' }, set: { teamId: 'x' }, remove: true }],
      [config(), { key: 'bindings', match: { projectId: 'At' }, set: {} }],
      [config(), { key: 'shared', match: { projectId: 'At' }, set: { teamId: 'x' } }],
      [null, { key: 'bindings', match: { projectId: 'At' }, set: { teamId: 'x' } }],
    ] as const) {
      expect(() => updateRuntimeConfigElements(current, update)).toThrow(RuntimeConfigElementUpdateError);
      try { updateRuntimeConfigElements(current, update); } catch (error) { expect((error as Error).message).not.toContain(SECRET); }
    }
  });
});

describe('PATCH /api/v1/config/services/:code/runtime-config/elements', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'excubitor-runtime-config-elements-'));
    process.env = {
      ...ORIGINAL_ENV,
      EXCUBITOR_CONFIG_PATH: join(tempDir, 'config.enc'),
      EXCUBITOR_MASTER_KEY: 'runtime-config-elements-test-master-key',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seed(app: ReturnType<typeof buildConfigRouter>): Promise<void> {
    const saved = await app.request('/api/v1/config/services/concordia/runtime-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { sharedSecret: SECRET, actioTaskBindings: [ACTIO, OTHER] } }),
    });
    expect(saved.status).toBe(200);
  }

  const patch = (app: ReturnType<typeof buildConfigRouter>, body: unknown) =>
    app.request('/api/v1/config/services/concordia/runtime-config/elements', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('updates the matching element, keeps the other keys and returns only counts and key names', async () => {
    const app = buildConfigRouter();
    await seed(app);

    const response = await patch(app, {
      key: 'actioTaskBindings', match: { repoPath: ACTIO.repoPath, teamId: null }, set: { teamId: 'team-1' },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACTIO.repoPath);
    expect(JSON.parse(text)).toEqual({
      ok: true, code: 'concordia', matched: 1,
      runtime_config: { configured: true, keys: ['actioTaskBindings', 'sharedSecret'] },
    });
    expect(getServiceRuntimeConfig('concordia')).toEqual({
      sharedSecret: SECRET, actioTaskBindings: [{ ...ACTIO, teamId: 'team-1' }, OTHER],
    });
  });

  it('reports zero matches without rewriting the config', async () => {
    const app = buildConfigRouter();
    await seed(app);

    const response = await patch(app, { key: 'actioTaskBindings', match: { projectId: 'none' }, remove: true });

    expect(await response.json()).toMatchObject({ ok: true, matched: 0 });
    expect(getServiceRuntimeConfig('concordia')).toEqual({ sharedSecret: SECRET, actioTaskBindings: [ACTIO, OTHER] });
  });

  it('rejects an unconfigured service, a non-array key and non-scalar values', async () => {
    const app = buildConfigRouter();
    const missing = await patch(app, { key: 'actioTaskBindings', match: { projectId: 'At' }, remove: true });
    expect(missing.status).toBe(400);

    await seed(app);
    const scalar = await patch(app, { key: 'sharedSecret', match: { projectId: 'At' }, remove: true });
    expect(scalar.status).toBe(400);
    expect(await scalar.text()).not.toContain(SECRET);

    const nested = await patch(app, { key: 'actioTaskBindings', match: { projectId: 'At' }, set: { teamId: { id: 'x' } } });
    expect(nested.status).toBe(400);
  });
});
