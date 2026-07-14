import { execCapture, type ExecResult } from '../shared/exec.js';

const START_TIME_TOLERANCE_MS = 5_000;

export interface VerifiedProcessIdentity {
  pid: number;
  startedAt: Date;
  verified: true;
}

export interface ProcessIdentityOptions {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => Promise<ExecResult>;
  toleranceMs?: number;
}

/**
 * Verify a persisted PID against the OS process creation time. A live PID is
 * insufficient because it may have been recycled while the supervisor was
 * down; callers must fail closed when creation time cannot be established.
 */
export async function verifyProcessIdentity(
  pid: number,
  expectedStartedAt: Date,
  options: ProcessIdentityOptions = {},
): Promise<VerifiedProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(expectedStartedAt.getTime())) return null;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? ((command, args) => execCapture(command, args, process.cwd(), 5_000));
  const result = platform === 'win32'
    ? await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o')`,
      ])
    : await run('ps', ['-p', String(pid), '-o', 'lstart=']);
  if (!result.ok) return null;
  const actualStartedAt = new Date(result.stdout.trim());
  if (Number.isNaN(actualStartedAt.getTime())) return null;
  const toleranceMs = options.toleranceMs ?? START_TIME_TOLERANCE_MS;
  if (Math.abs(actualStartedAt.getTime() - expectedStartedAt.getTime()) > toleranceMs) return null;
  return { pid, startedAt: actualStartedAt, verified: true };
}
