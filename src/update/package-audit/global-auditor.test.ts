import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecResult } from '../../shared/exec.js';
import type { PackageAuditConfig } from './config.js';

const mocks = vi.hoisted(() => ({
  execCapture: vi.fn(),
  npmGlobalPackages: vi.fn(),
  npmGlobalRoot: vi.fn(),
  npmLatestVersion: vi.fn(),
  npmOutdated: vi.fn(),
}));

vi.mock('../../shared/exec.js', () => ({ execCapture: mocks.execCapture }));
vi.mock('./npm-client.js', () => ({
  npmGlobalPackages: mocks.npmGlobalPackages,
  npmGlobalRoot: mocks.npmGlobalRoot,
  npmLatestVersion: mocks.npmLatestVersion,
  npmOutdated: mocks.npmOutdated,
}));

import { auditGlobalPackages } from './global-auditor.js';

const config: PackageAuditConfig = {
  include_unlisted_npm_globals: true,
  release_notes: { enabled: false, max_packages: 0 },
  global_cli: [{
    id: 'required-tool',
    command: 'required-tool',
    npm_package: '@example/required-tool',
    version_args: ['--version'],
    required: true,
  }],
};

beforeEach(() => {
  mocks.execCapture.mockReset();
  mocks.npmGlobalPackages.mockReset();
  mocks.npmGlobalRoot.mockReset();
  mocks.npmLatestVersion.mockReset();
  mocks.npmOutdated.mockReset();
  mocks.npmGlobalPackages.mockResolvedValue({
    ok: true,
    value: { '@example/required-tool': { version: '1.0.0', resolved: null } },
  });
  mocks.npmOutdated.mockResolvedValue({ ok: true, value: {} });
  mocks.npmGlobalRoot.mockResolvedValue({ ok: true, value: 'C:/npm/global' });
  mocks.npmLatestVersion.mockResolvedValue({ ok: true, value: '1.0.0' });
});

describe('global package audit', () => {
  it('reports a required CLI missing when its npm package exists but the command cannot run', async () => {
    const failedCommand: ExecResult = {
      ok: false,
      code: null,
      stdout: '',
      stderr: 'command not found',
    };
    mocks.execCapture.mockResolvedValue(failedCommand);

    const audit = await auditGlobalPackages(
      config,
      { command: process.execPath, prefixArgs: ['npm-cli.js'] },
      1_000,
    );

    expect(mocks.execCapture).toHaveBeenCalledWith(
      'required-tool',
      ['--version'],
      process.cwd(),
      1_000,
    );
    expect(audit.globalCli).toContainEqual(expect.objectContaining({
      id: 'required-tool',
      status: 'missing',
      source: 'missing',
    }));
    expect(audit.issues).toContainEqual(expect.objectContaining({
      target: 'required-tool',
      code: 'required_cli_missing',
    }));
  });
});
