import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import {
  parseLaunchctlPid,
  plistPreservesProcessGroup,
  plistUserName,
  resolveLaunchdJob,
  type LaunchdJob,
} from './launchd-job.js';
import type { SupervisorGeneration } from './supervisor-version.js';

/** @implements SPEC-EX-UNIFIED-UPDATE */
export interface SupervisorRestartPlan {
  commands: Array<{ command: string; args: string[] }>;
}

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error(command + ' failed; inspect the installed Excubitor OS service'));
      else resolve(stdout.trim());
    });
  });
}

export async function planSupervisorRestart(generation: SupervisorGeneration): Promise<SupervisorRestartPlan> {
  const name = process.env.EXCUBITOR_SERVICE_NAME?.trim() || (process.platform === 'win32' ? 'Excubitor' : 'excubitor');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('Unsupported OS service name');
  if (process.platform === 'linux') {
    const unit = name + '.service';
    const mode = await run('systemctl', ['--user', 'show', unit, '--property=KillMode', '--value']);
    const pid = await run('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value']);
    if (mode !== 'process' || Number(pid) !== generation.pid) throw new Error('Expected the current supervisor in a KillMode=process systemd user service');
    return { commands: [{ command: 'systemctl', args: ['--user', 'restart', unit] }] };
  }
  if (process.platform === 'darwin') {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('launchd user identity unavailable');
    const job = resolveLaunchdJob(name, { uid });
    const plist = await readFile(job.plistPath, 'utf8');
    const detail = await run('launchctl', ['print', job.target]);
    return planLaunchdRestart(job, plist, detail, generation.pid, userInfo().username);
  }
  if (process.platform === 'win32') {
    // The installed per-user task owns only the supervisor; the backend and services use WMI breakaway.
    // Never fall back to legacy Windows Service/NSSM or launch a second supervisor ourselves.
    await run('schtasks.exe', ['/Query', '/TN', name]);
    return { commands: [
      { command: 'schtasks.exe', args: ['/End', '/TN', name] },
      { command: 'schtasks.exe', args: ['/Run', '/TN', name] },
    ] };
  }
  throw new Error('OS supervisor restart is unsupported on ' + process.platform);
}

/**
 * A LaunchAgent is restarted by launchd itself. A boot-time LaunchDaemon lives in the
 * `system` domain, where kickstart needs root; it runs as this account with KeepAlive,
 * so SIGTERM to the verified supervisor pid makes launchd start a fresh one
 * (the same signal `kickstart -k` would send).
 */
export function planLaunchdRestart(
  job: LaunchdJob,
  plist: string,
  launchctlPrint: string,
  supervisorPid: number,
  currentUser: string,
): SupervisorRestartPlan {
  if (!plistPreservesProcessGroup(plist)) throw new Error('launchd must preserve managed processes (AbandonProcessGroup)');
  if (parseLaunchctlPid(launchctlPrint) !== supervisorPid) throw new Error('launchd supervisor identity mismatch');
  if (job.kind === 'agent') {
    return { commands: [{ command: 'launchctl', args: ['kickstart', '-k', job.target] }] };
  }
  if (!/<key>KeepAlive<\/key>\s*<true\s*\/>/.test(plist)) throw new Error('launchd daemon must declare KeepAlive to be restarted without root');
  if (plistUserName(plist) !== currentUser) throw new Error('launchd daemon must run as the current user (UserName)');
  return { commands: [{ command: 'kill', args: ['-TERM', String(supervisorPid)] }] };
}

export async function restartInstalledSupervisor(plan: SupervisorRestartPlan): Promise<void> {
  for (const command of plan.commands) await run(command.command, command.args);
}
