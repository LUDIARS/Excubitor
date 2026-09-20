import { execCapture, type ExecResult } from '../shared/exec.js';

const START_TIME_TOLERANCE_MS = 5_000;

export interface VerifiedProcessIdentity {
  pid: number;
  startedAt: Date;
  verified: true;
}

/**
 * 照合が成立しなかった理由。 対処が正反対なので呼び出し側で分岐できるようにする。
 *
 * - `exited`     — pid がもう存在しない。 起動そのものが失敗している。 調べるのは stderr。
 * - `unreadable` — pid がある、または不在を確認できず、作成時刻を読めない / 一致しない。
 *                  **プロセスは生き残りうる**ため、孤児として回収対象になる (design.md §17.4)。
 */
export type ProcessIdentityFailureReason = 'exited' | 'unreadable';

export type ProcessIdentityOutcome =
  | { ok: true; identity: VerifiedProcessIdentity }
  | { ok: false; reason: ProcessIdentityFailureReason };

/**
 * 期待値つき照合の結果。 `ProcessIdentityFailureReason` に `recycled` (pid 再利用) を加えて、
 * 「捨ててよい pid」と「捨ててはいけない pid」を呼び出し側が分けられるようにする。
 */
export type ProcessIdentityCheck =
  | { ok: true; identity: VerifiedProcessIdentity }
  | { ok: false; reason: ProcessIdentityFailureReason | 'recycled' };

type StartedAtProbe =
  | { kind: 'started-at'; startedAt: Date }
  | { kind: 'exited' }
  | { kind: 'unreadable' };

export interface ProcessIdentityOptions {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => Promise<ExecResult>;
  /** OS query failure時に PID がまだ存在するかを独立に確認する。 */
  isProcessAlive?: (pid: number) => boolean;
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
  const check = await checkProcessIdentity(pid, expectedStartedAt, options);
  return check.ok ? check.identity : null;
}

/**
 * `verifyProcessIdentity` と同じ照合をしつつ、 成立しなかった理由を残す。
 *
 * `probeProcessStartedAt` は「本当に居ない (`exited`)」と「居るが読めない (`unreadable`)」を
 * わざわざ区別しているのに、 `verifyProcessIdentity` が両方を `null` へ潰すため、 呼び出し側が
 * **生きているプロセスを死んだものとして捨てられてしまう**。 対処が正反対なので、 理由を保って返す口を用意する。
 *
 * - `exited`     — pid が存在しない。 死んでいる。
 * - `recycled`   — pid は生きているが作成時刻が期待値と違う。 別プロセスが pid を再利用している。
 * - `unreadable` — pid は生きている (または不在を確認できない) が作成時刻を読めない。
 *                  **まだ動いている可能性が高いので、 死亡扱いにしてはいけない。**
 */
export async function checkProcessIdentity(
  pid: number,
  expectedStartedAt: Date,
  options: ProcessIdentityOptions = {},
): Promise<ProcessIdentityCheck> {
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(expectedStartedAt.getTime())) {
    return { ok: false, reason: 'unreadable' };
  }
  const probe = await probeProcessStartedAt(pid, options);
  if (probe.kind === 'exited') return { ok: false, reason: 'exited' };
  if (probe.kind === 'unreadable') return { ok: false, reason: 'unreadable' };
  const toleranceMs = options.toleranceMs ?? START_TIME_TOLERANCE_MS;
  if (Math.abs(probe.startedAt.getTime() - expectedStartedAt.getTime()) > toleranceMs) {
    return { ok: false, reason: 'recycled' };
  }
  return { ok: true, identity: { pid, startedAt: probe.startedAt, verified: true } };
}

/**
 * 期待値を持たずに、生きている PID の作成時刻をそのまま読む。
 *
 * `verifyProcessIdentity` は「この pid は自分が起動したあの プロセスか」を確かめるためのもので、
 * 突合相手が要る。 対して boot 時の宣言ポート突合は「Excubitor が起動を記録できていない実体」を
 * 拾うのが目的で、期待作成時刻が存在しない (記録が無いことが問題そのもの)。 そこでは実測値を
 * そのまま identity として採用する。
 */
export async function readProcessIdentity(
  pid: number,
  options: ProcessIdentityOptions = {},
): Promise<VerifiedProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = await readProcessStartedAt(pid, options);
  return startedAt ? { pid, startedAt, verified: true } : null;
}

async function readProcessStartedAt(
  pid: number,
  options: ProcessIdentityOptions,
): Promise<Date | null> {
  const probe = await probeProcessStartedAt(pid, options);
  return probe.kind === 'started-at' ? probe.startedAt : null;
}

/**
 * 作成時刻を読むと同時に「読めなかった理由」を返す。
 *
 * `Get-Process` / `ps` の失敗には pid 不在だけでなく、timeout・権限・コマンド自体の
 * 起動失敗も含まれる。したがって非ゼロだけで `exited` と決めず、PID の存在を独立に
 * 確認する。存在確認まで不確かな場合は、生存プロセスを捨てない側 (`unreadable`) に倒す。
 */
async function probeProcessStartedAt(
  pid: number,
  options: ProcessIdentityOptions,
): Promise<StartedAtProbe> {
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
  if (!result.ok) {
    const isProcessAlive = options.isProcessAlive ?? hasLivePid;
    try {
      return isProcessAlive(pid) ? { kind: 'unreadable' } : { kind: 'exited' };
    } catch {
      // 存在確認そのものの失敗は「不在」の証拠にならない。孤児を見失わない側へ倒す。
      return { kind: 'unreadable' };
    }
  }
  const startedAt = new Date(result.stdout.trim());
  // 応答はあったが時刻にならない = pid は居るが読めない。 生存しうるので回収対象。
  if (Number.isNaN(startedAt.getTime())) return { kind: 'unreadable' };
  return { kind: 'started-at', startedAt };
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
  const outcome = await waitForProcessIdentityOutcome(pid, expectedStartedAt, options);
  return outcome.ok ? outcome.identity : null;
}

/**
 * `waitForProcessIdentity` と同じ待機をしつつ、失敗した理由を返す。
 *
 * 呼び出し側の対処が理由で分かれるため (即死なら起動失敗の調査、照合不能なら生存 pid の回収)、
 * 「照合できなかった」を 1 つの null に潰さない。 期限切れの最終判定は最後に観測した理由を採る。
 */
export async function waitForProcessIdentityOutcome(
  pid: number,
  expectedStartedAt: Date,
  options: ProcessIdentityWaitOptions = {},
): Promise<ProcessIdentityOutcome> {
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(expectedStartedAt.getTime())) {
    return { ok: false, reason: 'unreadable' };
  }
  const timeoutMs = options.timeoutMs ?? 0;
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + Math.max(0, timeoutMs);

  while (true) {
    const probe = await probeProcessStartedAt(pid, options);
    if (probe.kind === 'started-at') {
      const toleranceMs = options.toleranceMs ?? START_TIME_TOLERANCE_MS;
      const matches = Math.abs(probe.startedAt.getTime() - expectedStartedAt.getTime())
        <= toleranceMs;
      if (matches) {
        return { ok: true, identity: { pid, startedAt: probe.startedAt, verified: true } };
      }
    }
    // 作成時刻は読めたが一致しない場合も、 pid 自体は生きている = 回収対象。
    const reason: ProcessIdentityFailureReason = probe.kind === 'exited' ? 'exited' : 'unreadable';

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { ok: false, reason };
    await sleep(Math.min(Math.max(1, retryIntervalMs), remainingMs));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `false` は ESRCH (pid 不在) と確定できた場合だけ返す。 */
function hasLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}
