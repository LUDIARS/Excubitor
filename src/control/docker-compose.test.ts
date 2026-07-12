import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

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

    const pending = controlDockerCompose(service(), 'start');
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

    const pending = controlDockerCompose(service(), 'start');
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
    const pending = controlDockerCompose(service(), 'start');

    child.stdout.emit('data', Buffer.from(`discard-${'x'.repeat(DOCKER_OUTPUT_LIMIT_BYTES)}-tail`));
    child.emit('close', 0);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('[output truncated]');
    expect(result.stdout).toContain('-tail');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(DOCKER_OUTPUT_LIMIT_BYTES + 100);
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
