import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestLocalControl: vi.fn(),
  ensureLocalControlSupervisor: vi.fn(),
}));

vi.mock('./client.js', () => ({ requestLocalControl: mocks.requestLocalControl }));
vi.mock('./ensure-supervisor.js', () => ({
  ensureLocalControlSupervisor: mocks.ensureLocalControlSupervisor,
}));

import { runExcubitorCtl } from './cli.js';

describe('excubitorctl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.requestLocalControl.mockReset();
    mocks.ensureLocalControlSupervisor.mockReset().mockResolvedValue(undefined);
  });

  it('activates the installed supervisor for a mutation and emits one JSON response', async () => {
    const response = completedStatus('op-start');
    mocks.requestLocalControl.mockResolvedValue(response);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runExcubitorCtl(['service', 'demo', 'start', '--json'])).resolves.toBe(0);

    expect(mocks.ensureLocalControlSupervisor).toHaveBeenCalledTimes(1);
    expect(mocks.requestLocalControl).toHaveBeenCalledWith({
      target: { kind: 'service', code: 'demo' },
      action: 'start',
      actor: 'excubitorctl',
    });
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(response)}\n`);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('does not ask the OS manager to activate the supervisor for status', async () => {
    mocks.requestLocalControl.mockResolvedValue(completedStatus('op-status'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runExcubitorCtl(['service', 'demo', 'status', '--json'])).resolves.toBe(0);

    expect(mocks.ensureLocalControlSupervisor).not.toHaveBeenCalled();
  });

  it('parses emergency port arguments and preserves them in the request', async () => {
    mocks.requestLocalControl.mockResolvedValue(completedStatus('op-emergency'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runExcubitorCtl([
      'service', 'demo', 'kill-port', '--port=17332', '--json',
    ])).resolves.toBe(0);

    expect(mocks.requestLocalControl).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'service', code: 'demo' },
      action: 'kill-port',
      parameters: { port: 17332 },
    }));
  });

  it('uses exit code 2 and stderr for invalid arguments', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runExcubitorCtl(['service', 'demo', 'start', '--port=70000'])).resolves.toBe(2);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('excubitorctl: --port must be an integer from 1 to 65535\n');
    expect(mocks.requestLocalControl).not.toHaveBeenCalled();
  });

  it('keeps JSON-mode client failures on stdout and returns exit code 1', async () => {
    mocks.requestLocalControl.mockRejectedValue(new Error('endpoint unavailable'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runExcubitorCtl(['excubitor', 'status', '--json'])).resolves.toBe(1);

    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({
      ok: false,
      error: { code: 'CLIENT_ERROR', message: 'endpoint unavailable' },
    })}\n`);
    expect(stderr).not.toHaveBeenCalled();
  });
});

function completedStatus(operationId: string) {
  return {
    protocol_version: 1 as const,
    operation_id: operationId,
    ok: true as const,
    state: 'completed' as const,
    payload: {
      kind: 'service-status' as const,
      code: 'demo',
      runtime: 'node',
      state: 'stopped' as const,
      running: false,
      pid: null,
    },
  };
}
