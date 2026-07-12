import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  dbRun: vi.fn(),
  controlDockerCompose: vi.fn(),
  spawnService: vi.fn(),
  killService: vi.fn(),
  validateManagedProcess: vi.fn(),
  markServiceRunning: vi.fn(),
  markServiceStopped: vi.fn(),
  cancelServiceRestart: vi.fn(),
  waitForPendingSpawn: vi.fn(),
  resolveInjectEnv: vi.fn(),
  ensureTail: vi.fn(),
  runServiceBuild: vi.fn(),
  assertStartupEnv: vi.fn(),
}));

vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../db/client.js', () => ({ db: () => ({ run: mocks.dbRun }) }));
vi.mock('./docker-compose.js', () => ({ controlDockerCompose: mocks.controlDockerCompose }));
vi.mock('../process/manager.js', () => ({
  spawnService: mocks.spawnService,
  killService: mocks.killService,
  validateManagedProcess: mocks.validateManagedProcess,
  markServiceRunning: mocks.markServiceRunning,
  markServiceStopped: mocks.markServiceStopped,
  cancelServiceRestart: mocks.cancelServiceRestart,
  waitForPendingSpawn: mocks.waitForPendingSpawn,
}));
vi.mock('../process/inject.js', () => ({ resolveInjectEnv: mocks.resolveInjectEnv }));
vi.mock('../log/docker-tail.js', () => ({ ensureTail: mocks.ensureTail }));
vi.mock('../process/build.js', () => ({ runServiceBuild: mocks.runServiceBuild }));
vi.mock('../process/startup-env.js', () => ({ assertStartupEnv: mocks.assertStartupEnv }));

import { controlService } from './manager.js';

describe('control manager lifecycle guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateManagedProcess.mockResolvedValue(false);
    mocks.markServiceRunning.mockReturnValue(1);
    mocks.markServiceStopped.mockReturnValue(false);
    mocks.cancelServiceRestart.mockReturnValue(1);
    mocks.waitForPendingSpawn.mockResolvedValue(undefined);
    mocks.resolveInjectEnv.mockResolvedValue({ SECRET: 'resolved' });
    mocks.runServiceBuild.mockResolvedValue({
      ok: true,
      skipped: true,
      code: 0,
      command: '(build skipped)',
      stdout: '',
      stderr: '',
    });
    mocks.spawnService.mockResolvedValue({ child: { pid: 4321 } });
    mocks.killService.mockResolvedValue(true);
    mocks.controlDockerCompose.mockResolvedValue({
      ok: true,
      stdout: '',
      stderr: '',
      exit_code: 0,
      command: 'docker compose stop',
    });
  });

  it('treats an adopted process as already running', async () => {
    mocks.validateManagedProcess.mockResolvedValue(true);

    const result = await controlService(service(), 'start', 'test');

    expect(result).toMatchObject({ ok: true, stdout: 'already running', command: '(noop)' });
    expect(mocks.resolveInjectEnv).not.toHaveBeenCalled();
    expect(mocks.spawnService).not.toHaveBeenCalled();
    expect(mocks.validateManagedProcess).toHaveBeenCalledWith('demo');
  });

  it('resolves environment and builds before stopping for restart', async () => {
    const events: string[] = [];
    mocks.validateManagedProcess.mockResolvedValue(true);
    mocks.resolveInjectEnv.mockImplementation(async () => {
      events.push('env');
      return {};
    });
    mocks.runServiceBuild.mockImplementation(async () => {
      events.push('build');
      return { ok: true, skipped: true, code: 0, command: '(build skipped)', stdout: '', stderr: '' };
    });
    mocks.killService.mockImplementation(async () => {
      events.push('stop');
      return true;
    });
    mocks.spawnService.mockImplementation(async () => {
      events.push('spawn');
      return { child: { pid: 4321 } };
    });

    const result = await controlService(service(), 'restart', 'test');

    expect(result.ok).toBe(true);
    expect(events).toEqual(['env', 'build', 'stop', 'spawn']);
  });

  it('reports a verified stop failure', async () => {
    mocks.killService.mockRejectedValue(new Error('process did not terminate'));

    const result = await controlService(service(), 'stop', 'test');

    expect(result).toMatchObject({ ok: false, exit_code: -1, stderr: 'process did not terminate' });
  });

  it('does not resolve secrets for docker stop', async () => {
    const svc = service({ runtime: 'docker-compose', compose_file: 'compose.yml' });

    await controlService(svc, 'stop', 'test', { PUBLIC: 'value' });

    expect(mocks.resolveInjectEnv).not.toHaveBeenCalled();
    expect(mocks.assertStartupEnv).not.toHaveBeenCalled();
    expect(mocks.controlDockerCompose).toHaveBeenCalledWith(svc, 'stop', { PUBLIC: 'value' });
  });

  it('does not start a docker log tail from the lifecycle supervisor', async () => {
    const svc = service({ runtime: 'docker-compose', compose_file: 'compose.yml', container_names: ['demo'] });

    await controlService(svc, 'start', 'test');

    expect(mocks.ensureTail).not.toHaveBeenCalled();
  });
});

function service(overrides: Partial<Service> = {}): Service {
  return {
    code: 'demo',
    name: 'Demo',
    runtime: 'node',
    cwd: process.cwd(),
    command: 'node demo.js',
    disabled: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'always',
    max_restart: 5,
    required_env: [],
    ...overrides,
  } as Service;
}
