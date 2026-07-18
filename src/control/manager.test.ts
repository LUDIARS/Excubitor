import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { controlService } from './manager.js';

const mocks = vi.hoisted(() => ({
  controlDockerCompose: vi.fn(),
  spawnService: vi.fn(),
  killService: vi.fn(),
  getRunningProcess: vi.fn(),
  resolveInjectEnv: vi.fn(),
  ensureTail: vi.fn(),
  runServiceBuild: vi.fn(),
  assertStartupEnv: vi.fn(),
  dbRun: vi.fn(),
}));

vi.mock('../db/client.js', () => ({ db: () => ({ run: mocks.dbRun }) }));
vi.mock('./docker-compose.js', () => ({ controlDockerCompose: mocks.controlDockerCompose }));
vi.mock('../process/manager.js', () => ({
  spawnService: mocks.spawnService,
  killService: mocks.killService,
  getRunningProcess: mocks.getRunningProcess,
}));
vi.mock('../process/inject.js', () => ({ resolveInjectEnv: mocks.resolveInjectEnv }));
vi.mock('../log/docker-tail.js', () => ({ ensureTail: mocks.ensureTail }));
vi.mock('../process/build.js', () => ({ runServiceBuild: mocks.runServiceBuild }));
vi.mock('../process/startup-env.js', () => ({ assertStartupEnv: mocks.assertStartupEnv }));
vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
}));

function composeService(overrides: Partial<Service> = {}): Service {
  return {
    code: 'compose-app',
    name: 'Compose App',
    runtime: 'docker-compose',
    compose_file: 'E:/Document/Ars/ComposeApp/docker-compose.yaml',
    services: ['web'],
    required_env: [],
    ...overrides,
  } as Service;
}

describe('controlService docker-compose build', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveInjectEnv.mockResolvedValue({ FROM_INJECT: '1' });
    mocks.runServiceBuild.mockResolvedValue({
      ok: true,
      code: 0,
      stdout: 'built',
      stderr: '',
      command: 'npm run build',
      skipped: false,
    });
    mocks.controlDockerCompose.mockResolvedValue({
      ok: true,
      stdout: 'compose restarted',
      stderr: '',
      exit_code: 0,
      command: 'docker compose restart web',
    });
  });

  it('runs build before docker-compose restart', async () => {
    const svc = composeService({ build_command: 'npm run build' });

    const result = await controlService(svc, 'restart', 'tester', { OVERRIDE: '1' });

    expect(mocks.runServiceBuild).toHaveBeenCalledWith(svc, 'manual-restart');
    expect(mocks.controlDockerCompose).toHaveBeenCalledWith(svc, 'restart', {
      FROM_INJECT: '1',
      OVERRIDE: '1',
    });
    expect(result).toMatchObject({ ok: true, stdout: 'build ok\ncompose restarted' });
  });

  it('returns build failure without invoking docker-compose', async () => {
    const svc = composeService({ build_command: 'npm run build' });
    mocks.runServiceBuild.mockResolvedValueOnce({
      ok: false,
      code: 2,
      stdout: 'partial',
      stderr: 'build failed',
      command: 'npm run build',
      skipped: false,
    });

    const result = await controlService(svc, 'restart', 'tester');

    expect(mocks.controlDockerCompose).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      stdout: 'partial',
      stderr: 'build failed',
      exit_code: 2,
      command: 'npm run build',
    });
  });

  it('does not build before docker-compose stop', async () => {
    const svc = composeService({ build_command: 'npm run build' });

    await controlService(svc, 'stop', 'tester');

    expect(mocks.runServiceBuild).not.toHaveBeenCalled();
    expect(mocks.controlDockerCompose).toHaveBeenCalledWith(svc, 'stop', { FROM_INJECT: '1' });
  });
});
