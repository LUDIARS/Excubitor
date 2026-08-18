import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, openDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  readGitInfo: vi.fn(),
  resolveBuildVersion: vi.fn(),
}));

vi.mock('./git.js', () => ({ readGitInfo: mocks.readGitInfo }));
vi.mock('../shared/build-version.js', () => ({ resolveBuildVersion: mocks.resolveBuildVersion }));

import { reconcileStatus, syncDiskVersions } from './version-reconcile.js';

describe('reconcileStatus', () => {
  it('matches when the running process names the version that is on disk', () => {
    expect(reconcileStatus('0.1.0', '0.1.0')).toBe('match');
  });

  it('ignores surrounding whitespace', () => {
    expect(reconcileStatus(' 0.1.0 ', '0.1.0')).toBe('match');
  });

  it('flags a mismatch when disk moved ahead of the running process', () => {
    expect(reconcileStatus('0.2.0', '0.1.0')).toBe('mismatch');
  });

  it('matches on the git-derived identity used by version-less repos', () => {
    expect(reconcileStatus('0.0.0+abc1234', '0.0.0+abc1234')).toBe('match');
    expect(reconcileStatus('0.0.0+abc1234', '0.0.0+def5678')).toBe('mismatch');
  });

  it('stays unknown when the service does not name a version', () => {
    expect(reconcileStatus('0.1.0', null)).toBe('unknown');
    expect(reconcileStatus('0.1.0', '')).toBe('unknown');
  });

  it('stays unknown when the disk version could not be resolved', () => {
    expect(reconcileStatus(null, '0.1.0')).toBe('unknown');
  });

  it('does not report a match or mismatch for unresolved markers', () => {
    expect(reconcileStatus('0.1.0', 'unknown')).toBe('unknown');
    expect(reconcileStatus('0.0.0+unversioned', '0.0.0+unversioned')).toBe('unknown');
  });
});

describe('syncDiskVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbClientForTests();
    closeDb();
    resetDbClientForTests();
    openDb(':memory:');
    db().run(sql`
      INSERT INTO services (id, code, name, catalog_snapshot)
      VALUES ('demo-svc', 'demo', 'Demo', '{}')
    `);
    db().run(sql`
      INSERT INTO service_instances (id, service_id, state)
      VALUES ('demo-inst', 'demo-svc', 'running')
    `);
    mocks.readGitInfo.mockResolvedValue({
      branch: 'main',
      hash: 'abcdef123456',
      dirty: false,
      package_version: '1.2.3',
    });
    mocks.resolveBuildVersion.mockResolvedValue(null);
  });

  afterEach(() => {
    closeDb();
    resetDbClientForTests();
  });

  it('stores the resolved disk version and reports changed instance rows', async () => {
    const catalog = {
      services: [{
        code: 'demo',
        name: 'Demo',
        runtime: 'node',
        cwd: 'C:/services/demo',
        disabled: false,
        monitor_only: false,
      }],
      memory_monitor: {},
    } as unknown as Catalog;

    await expect(syncDiskVersions(catalog)).resolves.toEqual({ updated: 1 });
    expect(db().get(sql`
      SELECT disk_version
      FROM service_instances
      WHERE id = 'demo-inst'
    `)).toMatchObject({ disk_version: '1.2.3' });
  });

  it('uses Excubitor build identity instead of its package version', async () => {
    db().run(sql`
      INSERT INTO services (id, code, name, catalog_snapshot)
      VALUES ('excubitor-svc', 'excubitor', 'Excubitor', '{}')
    `);
    db().run(sql`
      INSERT INTO service_instances (id, service_id, state)
      VALUES ('excubitor-inst', 'excubitor-svc', 'running')
    `);
    mocks.resolveBuildVersion.mockResolvedValue({
      project_code: 'excubitor',
      major: 0,
      minor: 1,
      patch: 42,
      version: '0.1.42',
      patch_source: 'git',
      git_hash: 'abcdef123456',
    });
    const catalog = {
      services: [{
        code: 'excubitor',
        name: 'Excubitor',
        runtime: 'node',
        cwd: 'C:/services/excubitor',
        disabled: false,
        monitor_only: false,
      }],
      memory_monitor: {},
      project_versions: { excubitor: { major: 0, minor: 1 } },
    } as unknown as Catalog;

    await expect(syncDiskVersions(catalog)).resolves.toEqual({ updated: 1 });
    expect(db().get(sql`
      SELECT disk_version
      FROM service_instances
      WHERE id = 'excubitor-inst'
    `)).toMatchObject({ disk_version: '0.1.42' });
    expect(mocks.readGitInfo).not.toHaveBeenCalled();
  });
});
