import { describe, expect, it, vi } from 'vitest';
import { startSupervisorWithInfisicalIdentity } from './service-runner-infisical.js';

describe('startSupervisorWithInfisicalIdentity', () => {
  it('calls applyInfisicalToEnv before the supervisor is started', async () => {
    const events: string[] = [];
    const applyInfisicalToEnv = vi.fn(() => {
      events.push('identity');
      return true;
    });
    const logger = {
      info: vi.fn(() => {
        events.push('logged');
      }),
    };
    const supervisor = {
      start: vi.fn(async () => {
        events.push('supervisor-start');
      }),
    };

    await startSupervisorWithInfisicalIdentity(applyInfisicalToEnv, logger, supervisor);

    expect(applyInfisicalToEnv).toHaveBeenCalledOnce();
    expect(supervisor.start).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { identityApplied: true },
      'resolved Infisical identity for supervisor process env',
    );
    expect(events).toEqual(['identity', 'logged', 'supervisor-start']);
  });

  it('starts the supervisor even when no identity is configured', async () => {
    // identity 未設定は異常ではない。 secret を要求しないサービスは動かす必要があるので、
    // false を返しただけで起動を止めてはいけない。
    const applyInfisicalToEnv = vi.fn(() => false);
    const logger = { info: vi.fn() };
    const supervisor = { start: vi.fn(async () => {}) };

    const applied = await startSupervisorWithInfisicalIdentity(applyInfisicalToEnv, logger, supervisor);

    expect(applied).toBe(false);
    expect(supervisor.start).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { identityApplied: false },
      'resolved Infisical identity for supervisor process env',
    );
  });
});
