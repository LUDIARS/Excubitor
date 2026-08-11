import { describe, expect, it, vi } from 'vitest';

import type { PackageUpdate } from './types.js';

const mocks = vi.hoisted(() => ({ npmPackageMetadata: vi.fn() }));

vi.mock('./npm-client.js', () => ({ npmPackageMetadata: mocks.npmPackageMetadata }));

import { enrichReleaseNotes } from './release-notes.js';

const update: PackageUpdate = {
  scope: 'local',
  target: 'example-project',
  projects: ['example-project'],
  packageName: 'example-package',
  current: '1.0.0',
  wanted: '1.1.0',
  latest: '1.1.0',
  category: 'safe',
  semverImpact: 'safe',
  requiresRebuild: false,
  nativeReasons: [],
  dependencyType: 'dependencies',
  releaseNotes: null,
  releaseUrl: null,
};

describe('package release-note links', () => {
  it('does not publish arbitrary homepages for non-GitHub packages', async () => {
    mocks.npmPackageMetadata.mockResolvedValueOnce({
      ok: true,
      value: { repository: 'https://git.example.invalid/example/package' },
    });

    const result = await enrichReleaseNotes([update], {
      cwd: process.cwd(),
      invocation: { command: process.execPath, prefixArgs: ['npm-cli.js'] },
      timeoutMs: 1_000,
      maxPackages: 1,
      fetchImpl: vi.fn(),
    });

    expect(result.updates[0]?.releaseUrl).toBeNull();
  });

  it('falls back to the verified repository when a release URL is not on github.com', async () => {
    mocks.npmPackageMetadata.mockResolvedValueOnce({
      ok: true,
      value: { repository: 'https://github.com/example/package' },
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [{
        tag_name: 'v1.1.0',
        body: 'Release notes',
        html_url: 'https://redirect.example.invalid/release',
      }],
    } as Response));

    const result = await enrichReleaseNotes([update], {
      cwd: process.cwd(),
      invocation: { command: process.execPath, prefixArgs: ['npm-cli.js'] },
      timeoutMs: 1_000,
      maxPackages: 1,
      fetchImpl,
    });

    expect(result.updates[0]?.releaseUrl).toBe('https://github.com/example/package/releases');
    expect(result.updates[0]?.releaseNotes).toBe('Release notes');
  });
});
