import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, openDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({ readGitInfo: vi.fn() }));
vi.mock('./git.js', () => ({ readGitInfo: mocks.readGitInfo }));

import { syncSourceGitInfo } from './source-git.js';

function catalogOf(services: Record<string, unknown>[]): Catalog {
  return { services, memory_monitor: {} } as unknown as Catalog;
}

const nodeService = {
  code: 'demo', name: 'Demo', runtime: 'node', cwd: 'C:/services/demo',
  disabled: false, monitor_only: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetDbClientForTests();
  closeDb();
  resetDbClientForTests();
  openDb(':memory:');
  db().run(sql`INSERT INTO services (id, code, name, catalog_snapshot) VALUES ('demo-svc', 'demo', 'Demo', '{}')`);
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, git_branch, git_hash, git_dirty, package_version)
    VALUES ('demo-inst', 'demo-svc', 'running', 'agent/old-branch', 'oldoldoldold', 1, '0.9.0')
  `);
  mocks.readGitInfo.mockResolvedValue({ branch: 'main', hash: 'abcdef123456', dirty: false, package_version: '1.2.3' });
});

afterEach(() => {
  closeDb();
  resetDbClientForTests();
});

function instance(): Record<string, unknown> {
  return db().get(sql`
    SELECT git_branch, git_hash, git_dirty, package_version, state FROM service_instances WHERE id = 'demo-inst'
  `) as Record<string, unknown>;
}

describe('syncSourceGitInfo', () => {
  it('refreshes git info for a node service and leaves its state alone', async () => {
    await expect(syncSourceGitInfo(catalogOf([nodeService]))).resolves.toEqual({ updated: 1, skipped: 0 });
    expect(instance()).toMatchObject({
      git_branch: 'main', git_hash: 'abcdef123456', git_dirty: 0, package_version: '1.2.3', state: 'running',
    });
  });

  it('leaves docker services to the docker scan', async () => {
    const docker = { ...nodeService, runtime: 'docker-compose', compose_file: 'C:/services/demo/docker-compose.yaml' };
    await expect(syncSourceGitInfo(catalogOf([docker]))).resolves.toEqual({ updated: 0, skipped: 0 });
    expect(mocks.readGitInfo).not.toHaveBeenCalled();
    expect(instance()).toMatchObject({ git_branch: 'agent/old-branch' });
  });

  it('keeps the last known values when git cannot be read and skips monitor-only services', async () => {
    mocks.readGitInfo.mockResolvedValue({ branch: null, hash: null, dirty: null, package_version: null });
    await expect(syncSourceGitInfo(catalogOf([nodeService]))).resolves.toEqual({ updated: 0, skipped: 1 });
    expect(instance()).toMatchObject({ git_branch: 'agent/old-branch', git_hash: 'oldoldoldold' });

    mocks.readGitInfo.mockClear();
    await expect(syncSourceGitInfo(catalogOf([{ ...nodeService, monitor_only: true }]))).resolves.toEqual({ updated: 0, skipped: 1 });
    expect(mocks.readGitInfo).not.toHaveBeenCalled();
  });

  it('does not create an instance row for a service that has none', async () => {
    db().run(sql`INSERT INTO services (id, code, name, catalog_snapshot) VALUES ('fresh-svc', 'fresh', 'Fresh', '{}')`);
    await expect(syncSourceGitInfo(catalogOf([{ ...nodeService, code: 'fresh' }]))).resolves.toEqual({ updated: 0, skipped: 0 });
    expect(db().get(sql`SELECT COUNT(*) AS n FROM service_instances WHERE service_id = 'fresh-svc'`)).toMatchObject({ n: 0 });
  });
});
