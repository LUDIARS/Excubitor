import { describe, expect, it, vi } from 'vitest';
import {
  activateInstalledSupervisor,
  type SupervisorCommandRunner,
} from './supervisor-service-activation.js';

describe('activateInstalledSupervisor', () => {
  it('starts the registered Windows per-user scheduled task', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async () => undefined);

    await activateInstalledSupervisor({ platform: 'win32', env: {}, runCommand });

    expect(runCommand).toHaveBeenCalledWith('schtasks.exe', ['/Run', '/TN', 'Excubitor']);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('starts the Linux user service installed by install-service.sh', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async () => undefined);

    await activateInstalledSupervisor({ platform: 'linux', env: {}, runCommand });

    expect(runCommand).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'start', 'excubitor.service'],
    );
  });

  it('kickstarts the macOS LaunchAgent installed by install-service.sh', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async () => undefined);

    await activateInstalledSupervisor({
      platform: 'darwin',
      env: {},
      getUid: () => 501,
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith(
      'launchctl',
      ['kickstart', '-k', 'gui/501/com.ludiars.excubitor'],
    );
  });

  it('uses an explicitly configured service name', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async () => undefined);

    await activateInstalledSupervisor({
      platform: 'linux',
      env: { EXCUBITOR_SERVICE_NAME: 'excubitor-dev' },
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'start', 'excubitor-dev.service'],
    );
  });

  it('fails clearly when the Windows scheduled task is not installed', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async () => {
      throw new Error('not found');
    });

    await expect(activateInstalledSupervisor({
      platform: 'win32',
      env: {},
      runCommand,
    })).rejects.toThrow(/per-user scheduled task 'Excubitor' is not installed/i);
    expect(runCommand).toHaveBeenNthCalledWith(1, 'schtasks.exe', ['/Run', '/TN', 'Excubitor']);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'schtasks.exe', ['/Query', '/TN', 'Excubitor']);
    expect(runCommand).toHaveBeenNthCalledWith(3, 'sc.exe', ['query', 'Excubitor']);
  });

  it('does not misreport an installed task start failure as a legacy-service migration', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async (command, args) => {
      if (command === 'schtasks.exe' && args[0] === '/Run') throw new Error('start denied');
    });

    await expect(activateInstalledSupervisor({
      platform: 'win32',
      env: {},
      runCommand,
    })).rejects.toThrow(/scheduled task 'Excubitor' is installed but could not be started/i);

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).not.toHaveBeenCalledWith('sc.exe', expect.anything());
  });

  it('reports an explicit migration when only a legacy Windows service exists', async () => {
    const runCommand = vi.fn<SupervisorCommandRunner>(async (command) => {
      if (command === 'schtasks.exe') throw new Error('task not found');
    });

    await expect(activateInstalledSupervisor({
      platform: 'win32',
      env: {},
      runCommand,
    })).rejects.toThrow(/install-service\.ps1 -MigrateLegacyService/i);

    expect(runCommand).toHaveBeenNthCalledWith(1, 'schtasks.exe', ['/Run', '/TN', 'Excubitor']);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'schtasks.exe', ['/Query', '/TN', 'Excubitor']);
    expect(runCommand).toHaveBeenNthCalledWith(3, 'sc.exe', ['query', 'Excubitor']);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});
