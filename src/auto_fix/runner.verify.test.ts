import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  controlServiceViaLocalTool: vi.fn(),
}));

vi.mock('../local-control/service-adapter.js', () => ({
  controlServiceViaLocalTool: mocks.controlServiceViaLocalTool,
}));
vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { verifyService } from './runner.js';

describe('auto-fix service verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports still_crashing when the local-control restart returns a failure result', async () => {
    mocks.controlServiceViaLocalTool.mockResolvedValue({
      ok: false,
      stdout: '',
      stderr: 'supervisor unavailable',
      exit_code: -1,
      command: 'excubitorctl service alpha restart',
      local_control_error: 'unavailable',
    });

    await expect(verifyService(service())).resolves.toBe('still_crashing');
  });

  it('does not probe health until restart succeeds', async () => {
    mocks.controlServiceViaLocalTool.mockResolvedValue({
      ok: true,
      stdout: 'restarted',
      stderr: '',
      exit_code: 0,
      command: 'excubitorctl service alpha restart',
    });

    await expect(verifyService(service())).resolves.toBe('not_attempted');
  });
});

function service(): Service {
  return {
    code: 'alpha',
    name: 'Alpha',
    runtime: 'node',
    disabled: false,
    develop_derived: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'always',
    max_restart: 5,
    required_env: [],
  } as Service;
}
