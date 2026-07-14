import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { execCapture } from '../shared/exec.js';
import { probeServiceHealth } from './health.js';

vi.mock('../shared/exec.js', () => ({
  execCapture: vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' })),
}));

describe('command health checks', () => {
  it('never falls back to the service startup command', async () => {
    const service = {
      code: 'health-command-test',
      command: 'start-the-service',
      cwd: process.cwd(),
      health: { type: 'cmd', args: [], interval_sec: 30, grace_period_sec: 10 },
    } as unknown as Service;

    await expect(probeServiceHealth(service)).resolves.toMatchObject({
      ok: false,
      reason: 'failed',
      detail: 'health.command is required for cmd health',
    });
    expect(execCapture).not.toHaveBeenCalled();
  });

  it('executes only the dedicated health command and arguments', async () => {
    const service = {
      code: 'health-command-test',
      command: 'start-the-service',
      cwd: process.cwd(),
      health: {
        type: 'cmd',
        command: 'check-health',
        args: ['--read-only'],
        interval_sec: 30,
        grace_period_sec: 10,
      },
    } as unknown as Service;

    await expect(probeServiceHealth(service, undefined, 1234)).resolves.toMatchObject({ ok: true, reason: 'cmd' });
    expect(execCapture).toHaveBeenCalledWith('check-health', ['--read-only'], process.cwd(), 1234);
  });
});
