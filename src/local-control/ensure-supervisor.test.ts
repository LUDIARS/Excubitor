import { describe, expect, it, vi } from 'vitest';
import { ensureLocalControlSupervisor } from './ensure-supervisor.js';

describe('ensureLocalControlSupervisor', () => {
  it('does not activate a service when the supervisor is already reachable', async () => {
    const activateSupervisor = vi.fn(async () => undefined);

    await ensureLocalControlSupervisor({
      probeSupervisor: async () => true,
      activateSupervisor,
    });

    expect(activateSupervisor).not.toHaveBeenCalled();
  });

  it('activates once and polls until the endpoint is reachable', async () => {
    const probeResults = [false, false, true];
    const activateSupervisor = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    await ensureLocalControlSupervisor({
      probeSupervisor: async () => probeResults.shift() ?? true,
      activateSupervisor,
      sleep,
      startupTimeoutMs: 1_000,
    });

    expect(activateSupervisor).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reports install and foreground recovery when activation fails', async () => {
    await expect(ensureLocalControlSupervisor({
      probeSupervisor: async () => false,
      activateSupervisor: async () => { throw new Error('service is not installed'); },
      startupTimeoutMs: 0,
    })).rejects.toThrow(/install-service\.ps1.*install-service\.sh.*npm run service/i);
  });

  it('reports recovery when activation succeeds but readiness times out', async () => {
    await expect(ensureLocalControlSupervisor({
      probeSupervisor: async () => false,
      activateSupervisor: async () => undefined,
      startupTimeoutMs: 0,
    })).rejects.toThrow(/did not become ready.*install-service\.ps1.*npm run service/i);
  });
});
