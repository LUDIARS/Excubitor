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

export interface ProcessIdentityWaitOptions extends ProcessIdentityOptions {
  /** 照合不能だった直後に再試行する上限。0 なら 1 回だけ確認する。 */
  timeoutMs?: number;
  /** 照合の再試行間隔。 */
  retryIntervalMs?: number;
  /** テスト用の時刻・待機処理差し替え。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

/**
 * 作成直後の PID を短時間だけ照合し直す。
 *
 * Win32_Process.Create は pid を返してから Get-Process が StartTime を読めるまで
 * わずかに遅れることがある。成功条件は verifyProcessIdentity と同じ作成時刻一致だけに
 * 限定し、期限内に照合できなければ null を返して呼び出し側を fail-closed のままにする。
 */
export async function waitForProcessIdentity(
  pid: number,
  expectedStartedAt: Date,
  options: ProcessIdentityWaitOptions = {},
): Promise<VerifiedProcessIdentity | null> {
  const timeoutMs = options.timeoutMs ?? 0;
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + Math.max(0, timeoutMs);

  while (true) {
    const identity = await verifyProcessIdentity(pid, expectedStartedAt, options);
    if (identity) return identity;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return null;
    await sleep(Math.min(Math.max(1, retryIntervalMs), remainingMs));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
