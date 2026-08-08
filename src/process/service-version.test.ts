import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  readGitInfo: vi.fn(),
}));

vi.mock('../scanner/git.js', () => ({ readGitInfo: mocks.readGitInfo }));

import {
  injectServiceRuntimeVersion,
  resolveServiceRuntimeVersion,
  SERVICE_VERSION_ENV,
  VITE_SERVICE_VERSION_ENV,
} from './service-version.js';

describe('service runtime version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers a trimmed package version from the catalog source checkout', async () => {
    mocks.readGitInfo.mockResolvedValue({
      branch: 'main',
      hash: 'abcdef123456',
      dirty: false,
      package_version: ' 2.3.4 ',
    });

    await expect(resolveServiceRuntimeVersion(service())).resolves.toEqual({
      value: '2.3.4',
      source: 'package',
    });
    expect(mocks.readGitInfo).toHaveBeenCalledWith('C:/services/demo');
  });

  it('falls back to a Git build identifier when the package version is unsafe', async () => {
    mocks.readGitInfo.mockResolvedValue({
      branch: 'main',
      hash: 'abcdef123456',
      dirty: false,
      package_version: 'bad\nversion',
    });

    await expect(resolveServiceRuntimeVersion(service())).resolves.toEqual({
      value: '0.0.0+abcdef123456',
      source: 'git',
    });
  });

  it('overrides caller-provided values in both runtime environment contracts', async () => {
    mocks.readGitInfo.mockResolvedValue({
      branch: null,
      hash: null,
      dirty: null,
      package_version: '1.2.3',
    });

    const versioned = await injectServiceRuntimeVersion(service(), {
      KEEP: 'value',
      [SERVICE_VERSION_ENV]: 'spoofed',
      [VITE_SERVICE_VERSION_ENV]: 'spoofed',
    });

    expect(versioned.env).toEqual({
      KEEP: 'value',
      [SERVICE_VERSION_ENV]: '1.2.3',
      [VITE_SERVICE_VERSION_ENV]: '1.2.3',
    });
  });

  it('uses an explicit marker without running Git when no source directory exists', async () => {
    const withoutSource = service({ cwd: undefined });

    await expect(resolveServiceRuntimeVersion(withoutSource)).resolves.toEqual({
      value: '0.0.0+unversioned',
      source: 'unversioned',
    });
    expect(mocks.readGitInfo).not.toHaveBeenCalled();
  });
});

function service(overrides: Partial<Service> = {}): Service {
  return {
    code: 'demo',
    name: 'Demo',
    runtime: 'node',
    cwd: 'C:/services/demo',
    command: 'node demo.js',
    disabled: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'no',
    max_restart: 0,
    required_env: [],
    ...overrides,
  } as Service;
}
