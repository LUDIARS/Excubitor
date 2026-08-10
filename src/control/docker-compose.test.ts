import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => {
  const disposeOverride = vi.fn(async () => undefined);
  return {
    spawn: vi.fn(),
    disposeOverride,
    createComposeVersionOverride: vi.fn(async () => ({
      path: 'compose.version.override.yaml',
      dispose: disposeOverride,
    })),
  };
});

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./compose-version-override.js', () => ({
  createComposeVersionOverride: mocks.createComposeVersionOverride,
}));

import {
  controlDockerCompose,
  DOCKER_CONTROL_TIMEOUT_MS,
  DOCKER_OUTPUT_LIMIT_BYTES,
  DOCKER_TERMINATION_GRACE_MS,
} from './docker-compose.js';

describe('docker compose control bounds', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('terminates and reports a timed out docker command', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const pending = controlDockerCompose(service(), 'start', versionedEnv());
    await vi.advanceTimersByTimeAsync(DOCKER_CONTROL_TIMEOUT_MS);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', null);
    const result = await pending;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ ok: false, exit_code: -1 });
    expect(result.stderr).toContain('timeout');
  });

  it('escalates and explicitly reports when termination cannot be confirmed', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const pending = controlDockerCompose(service(), 'start', versionedEnv());
    await vi.advanceTimersByTimeAsync(DOCKER_CONTROL_TIMEOUT_MS + DOCKER_TERMINATION_GRACE_MS);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(DOCKER_TERMINATION_GRACE_MS);
    const result = await pending;

    expect(result).toMatchObject({ ok: false, exit_code: -1 });
    expect(result.stderr).toContain('unable to confirm termination');
  });

  it('retains only a bounded tail of docker output', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const pending = controlDockerCompose(service(), 'start', versionedEnv());

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());

    child.stdout.emit('data', Buffer.from(`discard-${'x'.repeat(DOCKER_OUTPUT_LIMIT_BYTES)}-tail`));
    child.emit('close', 0);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('[output truncated]');
    expect(result.stdout).toContain('-tail');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(DOCKER_OUTPUT_LIMIT_BYTES + 100);
  });

  it('adds and disposes the generated override for a versioned start', async () => {
    const svc = service();
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const pending = controlDockerCompose(svc, 'start', versionedEnv());
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('failed to read compose.version.override.yaml'));
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      command: 'docker compose -f compose.yml -f <runtime-version-override> up -d demo',
      stderr: 'failed to read <runtime-version-override>',
    });
    expect(mocks.createComposeVersionOverride).toHaveBeenCalledWith(svc, '1.0.0');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      [
        'compose', '-f', 'compose.yml',
        '-f', 'compose.version.override.yaml',
        'up', '-d', 'demo',
      ],
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining(versionedEnv()),
      }),
    );
    expect(mocks.disposeOverride).toHaveBeenCalledOnce();
  });

  it('does not require or create a version override when stopping', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const pending = controlDockerCompose(service(), 'stop');
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.createComposeVersionOverride).not.toHaveBeenCalled();
    expect(mocks.disposeOverride).not.toHaveBeenCalled();
  });

  it('recreates containers on restart so the new environment is applied', async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    const pending = controlDockerCompose(service(), 'restart', versionedEnv());
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'docker',
      [
        'compose', '-f', 'compose.yml',
        '-f', 'compose.version.override.yaml',
        'up', '-d', '--force-recreate', '--no-deps', 'demo',
      ],
      expect.any(Object),
    );
  });

  it('fails before spawning when a start has no authoritative version', async () => {
    await expect(controlDockerCompose(service(), 'start')).rejects.toThrow('EXCUBITOR_SERVICE_VERSION');
    expect(mocks.createComposeVersionOverride).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

function fakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

function service(): Service {
  return {
    code: 'compose-demo',
    name: 'Compose Demo',
    runtime: 'docker-compose',
    compose_file: 'compose.yml',
    services: ['demo'],
    disabled: false,
    develop_derived: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'no',
    max_restart: 0,
    required_env: [],
  } as Service;
}

function versionedEnv(): Record<string, string> {
  return { EXCUBITOR_SERVICE_VERSION: '1.0.0' };
}
