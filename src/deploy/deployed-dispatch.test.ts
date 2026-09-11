import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { dispatchServiceDeployment } from './deployed-dispatch.js';

describe('service deployed dispatch', () => {
  beforeEach(() => { resetDbClientForTests(); closeDb(); resetDbClientForTests(); openDb(':memory:'); vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 }))); });
  afterEach(() => { vi.unstubAllGlobals(); closeDb(); resetDbClientForTests(); });
  const input = (gitHash: string) => ({ code: 'demo', gitHash, version: '1.0.0', startedAt: new Date('2026-09-11T00:00:00.000Z'), restartCount: 1 });

  it('does not dispatch the initial observed hash', async () => {
    await expect(dispatchServiceDeployment(input('first'))).resolves.toBe('initial');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('dispatches when the persisted hash changes', async () => {
    await dispatchServiceDeployment(input('first'));
    await expect(dispatchServiceDeployment(input('second'))).resolves.toBe('dispatched');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/events/service-deployed'), expect.objectContaining({ body: expect.stringContaining('"previousHash":"first"') }));
  });
  it('does not dispatch an unchanged hash', async () => {
    await dispatchServiceDeployment(input('same'));
    await expect(dispatchServiceDeployment(input('same'))).resolves.toBe('unchanged');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('contains a dispatch failure after persisting the new hash', async () => {
    await dispatchServiceDeployment(input('first'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(dispatchServiceDeployment(input('second'))).resolves.toBe('failed');
    expect(db().get(sql`SELECT git_hash FROM service_deployments WHERE service_code = ${'demo'}`)).toEqual({ git_hash: 'second' });
  });
});
