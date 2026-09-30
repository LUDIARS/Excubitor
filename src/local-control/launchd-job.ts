import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

// launchd paths are macOS paths regardless of where this module is evaluated.
const { join } = posix;

/**
 * How the macOS supervisor is registered with launchd.
 *
 * - `agent`: per-user LaunchAgent (`~/Library/LaunchAgents`), started at login in `gui/<uid>`.
 * - `daemon`: LaunchDaemon (`/Library/LaunchDaemons`) with `UserName`, started at boot in `system`.
 *   It runs as the same account as the CLI, but `launchctl kickstart system/...` needs root, so
 *   callers rely on `KeepAlive` and signal the supervisor pid instead of asking launchd.
 */
export interface LaunchdJob {
  kind: 'agent' | 'daemon';
  label: string;
  plistPath: string;
  /** launchctl service target, e.g. `gui/501/com.ludiars.excubitor` or `system/com.ludiars.excubitor`. */
  target: string;
}

export const LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons';

export interface ResolveLaunchdJobOptions {
  uid: number;
  homeDir?: string;
  exists?: (path: string) => boolean;
}

export function launchdLabel(serviceName: string): string {
  return 'com.ludiars.' + serviceName;
}

/** The boot-time LaunchDaemon wins when installed; install-service.sh --boot removes the agent. */
export function resolveLaunchdJob(serviceName: string, options: ResolveLaunchdJobOptions): LaunchdJob {
  const label = launchdLabel(serviceName);
  const exists = options.exists ?? existsSync;
  const daemonPlist = join(LAUNCH_DAEMONS_DIR, label + '.plist');
  if (exists(daemonPlist)) {
    return { kind: 'daemon', label, plistPath: daemonPlist, target: 'system/' + label };
  }
  return {
    kind: 'agent',
    label,
    plistPath: join(options.homeDir ?? homedir(), 'Library', 'LaunchAgents', label + '.plist'),
    target: 'gui/' + options.uid + '/' + label,
  };
}

/** `launchctl print` reports the running pid as `pid = <n>`. */
export function parseLaunchctlPid(detail: string): number | undefined {
  const pid = /^\s*pid = (\d+)\s*$/m.exec(detail)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

export function plistPreservesProcessGroup(plist: string): boolean {
  return /<key>AbandonProcessGroup<\/key>\s*<true\s*\/>/.test(plist);
}

/** The value of `<key>UserName</key><string>...</string>`, if declared. */
export function plistUserName(plist: string): string | undefined {
  return /<key>UserName<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
}
