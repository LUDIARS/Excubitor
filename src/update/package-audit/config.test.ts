import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readRuntimeConfig: vi.fn() }));

vi.mock('../../catalog/runtime-config.js', () => ({
  DEFAULT_RUNTIME_CONFIG_PATH: 'excubitor.config.yaml',
  readRuntimeConfig: mocks.readRuntimeConfig,
}));

import { loadPackageAuditConfig } from './config.js';

describe('package audit configuration', () => {
  it('rejects shell metacharacters in declared CLI version commands', () => {
    mocks.readRuntimeConfig.mockReturnValue({
      package_audit: {
        global_cli: [{
          id: 'unsafe',
          command: 'tool.cmd',
          npm_package: '@example/tool',
          version_args: ['--version & whoami'],
        }],
      },
    });

    expect(() => loadPackageAuditConfig()).toThrow(/shell metacharacters/);
  });
});
