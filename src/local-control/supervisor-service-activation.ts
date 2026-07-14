import { execFile } from 'node:child_process';

export type SupervisorCommandRunner = (command: string, args: readonly string[]) => Promise<void>;

export interface SupervisorServiceActivationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  getUid?: () => number;
  runCommand?: SupervisorCommandRunner;
}

const WINDOWS_SERVICE_NAME = 'Excubitor';
const POSIX_SERVICE_NAME = 'excubitor';

/** Ask the platform service manager to start the installed supervisor. */
export async function activateInstalledSupervisor(
  options: SupervisorServiceActivationOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runSupervisorCommand;

  if (platform === 'win32') {
    await activateWindowsSupervisor(serviceName(env, WINDOWS_SERVICE_NAME), runCommand);
    return;
  }
  if (platform === 'linux') {
    const name = serviceName(env, POSIX_SERVICE_NAME);
    await runOrThrow(
      runCommand,
      'systemctl',
      ['--user', 'start', `${name}.service`],
      `systemd user service '${name}.service' is not installed or could not be started`,
    );
    return;
  }
  if (platform === 'darwin') {
    const name = serviceName(env, POSIX_SERVICE_NAME);
    const label = `com.ludiars.${name}`;
    const uid = (options.getUid ?? process.getuid)?.();
    if (uid === undefined) {
      throw new Error('launchd activation requires the current user id');
    }
    await activateLaunchdSupervisor(label, uid, runCommand);
    return;
  }

  throw new Error(`automatic supervisor activation is unsupported on platform '${platform}'`);
}

async function activateWindowsSupervisor(
  name: string,
  runCommand: SupervisorCommandRunner,
): Promise<void> {
  try {
    await runCommand('schtasks.exe', ['/Run', '/TN', name]);
    return;
  } catch (scheduledTaskError) {
    let scheduledTaskInstalled = false;
    try {
      await runCommand('schtasks.exe', ['/Query', '/TN', name]);
      scheduledTaskInstalled = true;
    } catch {
      // Absence is distinguished below from the unsupported legacy service.
    }
    if (scheduledTaskInstalled) {
      throw new Error(
        `Windows per-user scheduled task '${name}' is installed but could not be started`,
        { cause: scheduledTaskError },
      );
    }
    try {
      // Deliberately do not start the legacy service. Windows Service/NSSM
      // processes commonly run at a different integrity level from the CLI,
      // which gives them a different named-pipe namespace and can create two
      // concurrent local-control owners. The installer performs the explicit,
      // reversible migration to a per-user task.
      await runCommand('sc.exe', ['query', name]);
    } catch {
      throw new Error(
        `Windows per-user scheduled task '${name}' is not installed or could not be started`,
        { cause: scheduledTaskError },
      );
    }
    throw new Error(
      `Legacy Windows Service/NSSM service '${name}' is installed, but it is not a supported local-control owner. `
        + `Run scripts/install-service.ps1 -MigrateLegacyService from an elevated PowerShell to migrate it safely; `
        + 'the legacy service was not started.',
      { cause: scheduledTaskError },
    );
  }
}

async function activateLaunchdSupervisor(
  label: string,
  uid: number,
  runCommand: SupervisorCommandRunner,
): Promise<void> {
  try {
    await runCommand('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
  } catch (kickstartError) {
    try {
      // `start` supports LaunchAgents installed by the legacy `launchctl load`
      // command used by scripts/install-service.sh.
      await runCommand('launchctl', ['start', label]);
    } catch (startError) {
      throw new AggregateError(
        [kickstartError, startError],
        `launchd agent '${label}' is not installed or could not be started`,
      );
    }
  }
}

function serviceName(env: NodeJS.ProcessEnv, fallback: string): string {
  return env.EXCUBITOR_SERVICE_NAME?.trim() || fallback;
}

async function runOrThrow(
  runCommand: SupervisorCommandRunner,
  command: string,
  args: readonly string[],
  message: string,
): Promise<void> {
  try {
    await runCommand(command, args);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

function runSupervisorCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error) => {
      if (!error) {
        resolveCommand();
        return;
      }
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      rejectCommand(new Error(`${command} failed (code=${code})`, { cause: error }));
    });
  });
}
