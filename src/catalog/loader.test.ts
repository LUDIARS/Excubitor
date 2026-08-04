import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  warn: vi.fn(),
}));

vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../shared/roots.js', () => ({
  arsRoot: () => mocks.root,
  domainRoot: () => '.example.test',
}));

import { clearFragmentCache } from './fragments.js';
import { loadCatalog } from './loader.js';

const envKeys = [
  'EXCUBITOR_ARS_ROOT',
  'LUDIARS_ROOT',
  'EXCUBITOR_FRAGMENT_DIRS',
  'EXCUBITOR_TRUSTED_FRAGMENT_REPOS',
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

function writeYaml(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
}

function writeFragment(repo: string, body: string): string {
  const repoDir = join(mocks.root, repo);
  mkdirSync(repoDir, { recursive: true });
  const path = join(repoDir, 'excubitor.catalog.yaml');
  writeYaml(path, body);
  return path;
}

beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'excubitor-loader-'));
  tempDirs.push(mocks.root);
  process.env.EXCUBITOR_ARS_ROOT = mocks.root;
  delete process.env.LUDIARS_ROOT;
  delete process.env.EXCUBITOR_FRAGMENT_DIRS;
  delete process.env.EXCUBITOR_TRUSTED_FRAGMENT_REPOS;
  mocks.warn.mockReset();
  clearFragmentCache();
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearFragmentCache();
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe('catalog source merge', () => {
  it('fails closed when multiple repositories claim the same service code', () => {
    const configPath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(configPath, '{}\n');
    const first = writeFragment('RepoA', [
      'services:',
      '  - code: shared',
      '    name: First Owner',
      '    runtime: node',
    ].join('\n'));
    const second = writeFragment('RepoB', [
      'services:',
      '  - code: shared',
      '    name: Second Owner',
      '    runtime: node',
    ].join('\n'));
    process.env.EXCUBITOR_TRUSTED_FRAGMENT_REPOS = 'RepoA,RepoB';

    expect(loadCatalog(configPath).services).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { code: 'shared', sources: [first.replace(/\\/g, '/'), second.replace(/\\/g, '/')] },
      'conflicting service-owned catalogs ignored',
    );
  });

  it('logs fragment schema failures with their source instead of dropping them silently', () => {
    const basePath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(basePath, '{}\n');
    const source = writeFragment('Invalid', [
      'services:',
      '  - code: invalid',
      '    name: Invalid',
      '    runtime: unsupported-runtime',
    ].join('\n'));

    expect(loadCatalog(basePath).services).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: source.replace(/\\/g, '/'), code: 'invalid' }),
      'invalid catalog fragment service ignored',
    );
  });

  it('rejects runnable service definitions from a repository outside the trust allowlist', () => {
    const basePath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(basePath, '{}\n');
    const source = writeFragment('Untrusted', [
      'services:',
      '  - code: untrusted',
      '    name: Untrusted',
      '    runtime: node',
      '    infisical:',
      '      project_id: project',
      '      environment: dev',
      '      inject: true',
    ].join('\n'));

    expect(loadCatalog(basePath).services).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: source.replace(/\\/g, '/'),
        code: 'untrusted',
      }),
      'untrusted catalog fragment service ignored',
    );
  });

  it('accepts privileged fields from an explicitly allowlisted repository', () => {
    process.env.EXCUBITOR_TRUSTED_FRAGMENT_REPOS = 'Trusted';
    const basePath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(basePath, '{}\n');
    writeFragment('Trusted', [
      'services:',
      '  - code: trusted',
      '    name: Trusted',
      '    runtime: node',
      '    infisical:',
      '      project_id: project',
      '      environment: dev',
      '      inject: true',
    ].join('\n'));

    expect(loadCatalog(basePath).services).toEqual([
      expect.objectContaining({ code: 'trusted', infisical: expect.objectContaining({ project_id: 'project' }) }),
    ]);
  });

  it('accepts privileged fields from a repository owned by the trusted GitHub organization', () => {
    const basePath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(basePath, '{}\n');
    const repositoryPath = join(mocks.root, 'OrganizationRepo');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    writeYaml(
      join(repositoryPath, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/LUDIARS/OrganizationRepo.git\n',
    );
    writeFragment('OrganizationRepo', [
      'services:',
      '  - code: organization-repo',
      '    name: Organization Repo',
      '    runtime: node',
      '    requires_secret:',
      '      - service: source',
      '        keys: [NAMED_SECRET]',
    ].join('\n'));

    expect(loadCatalog(basePath).services).toEqual([
      expect.objectContaining({ code: 'organization-repo', requires_secret: [{ service: 'source', keys: ['NAMED_SECRET'] }] }),
    ]);
  });

  // 既定構成では ARS_ROOT は env ではなく cwd の親から解決される。root を untrusted 扱いにすると
  // その構成で catalog が丸ごと空になり、監視も起動もできなくなる。
  it('accepts trusted repositories when the workspace root came from the implicit default', () => {
    delete process.env.EXCUBITOR_ARS_ROOT;
    delete process.env.LUDIARS_ROOT;
    const basePath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(basePath, '{}\n');
    const repositoryPath = join(mocks.root, 'ImplicitRoot');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    writeYaml(
      join(repositoryPath, '.git', 'config'),
      '[remote "origin"]\n  url = https://github.com/LUDIARS/ImplicitRoot.git\n',
    );
    writeFragment('ImplicitRoot', [
      'services:',
      '  - code: implicit-root',
      '    name: Implicit Root',
      '    runtime: node',
    ].join('\n'));

    expect(loadCatalog(basePath).services).toEqual([
      expect.objectContaining({ code: 'implicit-root' }),
    ]);
  });

  it('still rejects an untrusted repository when the workspace root came from the implicit default', () => {
    delete process.env.EXCUBITOR_ARS_ROOT;
    delete process.env.LUDIARS_ROOT;
    const basePath = join(mocks.root, 'excubitor.config.yaml');
    writeYaml(basePath, '{}\n');
    writeFragment('Foreign', [
      'services:',
      '  - code: foreign',
      '    name: Foreign',
      '    runtime: node',
    ].join('\n'));

    expect(loadCatalog(basePath).services).toEqual([]);
  });
});
