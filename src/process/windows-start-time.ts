import { execCapture, type ExecResult } from '../shared/exec.js';

/**
 * Windows のプロセス作成時刻を読む。 複数 pid を PowerShell 1 回で読む。
 *
 * 作成時刻の照合 (identity.ts) は AdoptedProcessReaper が 5 秒ごとに再採用サービスの数だけ
 * 呼ぶ。 1 pid ごとに powershell.exe を起動していた頃は 30 秒で 35 本の PowerShell が立ち、
 * その起動と Defender の検査で 3 コア以上を使っていた (2026-10-10、 CPU 100% のなかで backend が
 * readiness に間に合わず 2〜3 分おきに再起動していた)。 同じ時期に届いた照合をまとめて 1 回にする。
 */

export type WindowsStartTimeLookup =
  /** 作成時刻を読めた。 */
  | { kind: 'started-at'; startedAt: Date }
  /** 問い合わせは成功したが、 その pid の行が無い (不在か、 権限で StartTime を読めない)。 */
  | { kind: 'missing' }
  /** pid の行はあるが時刻にならない。 */
  | { kind: 'unparsable' }
  /** 問い合わせそのものが失敗した (timeout・起動失敗など)。 */
  | { kind: 'failed' };

export type WindowsStartTimeRunner = (command: string, args: string[]) => Promise<ExecResult>;

const QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_BATCH_WINDOW_MS = 20;

export const defaultWindowsStartTimeRunner: WindowsStartTimeRunner = (command, args) =>
  execCapture(command, args, process.cwd(), QUERY_TIMEOUT_MS);

/**
 * pid ごとに `<pid> <ISO 8601 UTC>` を 1 行出す。 居ない pid は Get-Process が黙って飛ばすので、
 * 問い合わせ全体は成功させる (`exit 0`)。 不在か否かの最終判定は呼び出し側が独立に行う。
 */
export function windowsStartTimeScript(pids: readonly number[]): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `foreach ($p in (Get-Process -Id ${pids.join(',')})) { if ($p.StartTime) { '{0} {1}' -f $p.Id, $p.StartTime.ToUniversalTime().ToString('o') } }`,
    'exit 0',
  ].join('; ');
}

export function parseWindowsStartTimes(stdout: string): Map<number, Date | null> {
  const times = new Map<number, Date | null>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const startedAt = new Date(match[2]!);
    times.set(Number(match[1]), Number.isNaN(startedAt.getTime()) ? null : startedAt);
  }
  return times;
}

/** 渡された pid をまとめて 1 回で問い合わせる。 */
export async function queryWindowsStartTimes(
  pids: readonly number[],
  run: WindowsStartTimeRunner = defaultWindowsStartTimeRunner,
): Promise<Map<number, WindowsStartTimeLookup>> {
  const unique = Array.from(new Set(pids));
  const result = new Map<number, WindowsStartTimeLookup>();
  if (unique.length === 0) return result;
  const response = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsStartTimeScript(unique),
  ]);
  if (!response.ok) {
    for (const pid of unique) result.set(pid, { kind: 'failed' });
    return result;
  }
  const times = parseWindowsStartTimes(response.stdout);
  for (const pid of unique) {
    if (!times.has(pid)) {
      result.set(pid, { kind: 'missing' });
      continue;
    }
    const startedAt = times.get(pid);
    result.set(pid, startedAt ? { kind: 'started-at', startedAt } : { kind: 'unparsable' });
  }
  return result;
}

export interface WindowsStartTimeBatcherOptions {
  run?: WindowsStartTimeRunner;
  /** 最初の照合が届いてから、 同じ問い合わせへ相乗りを受け付ける時間。 */
  windowMs?: number;
}

/**
 * 短い窓のあいだに届いた照合を 1 回の問い合わせへ相乗りさせる。
 * 結果は保持しない (pid の再利用を見逃さないよう、 照合のたびに OS から読む)。
 */
export class WindowsStartTimeBatcher {
  private readonly run: WindowsStartTimeRunner;
  private readonly windowMs: number;
  private pending = new Map<number, Array<(lookup: WindowsStartTimeLookup) => void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: WindowsStartTimeBatcherOptions = {}) {
    this.run = options.run ?? defaultWindowsStartTimeRunner;
    this.windowMs = Math.max(0, options.windowMs ?? DEFAULT_BATCH_WINDOW_MS);
  }

  read(pid: number): Promise<WindowsStartTimeLookup> {
    return new Promise((resolve) => {
      const waiters = this.pending.get(pid);
      if (waiters) waiters.push(resolve);
      else this.pending.set(pid, [resolve]);
      if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.windowMs);
        this.timer.unref?.();
      }
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = this.pending;
    this.pending = new Map();
    let lookups: Map<number, WindowsStartTimeLookup>;
    try {
      lookups = await queryWindowsStartTimes(Array.from(batch.keys()), this.run);
    } catch {
      lookups = new Map();
    }
    for (const [pid, waiters] of batch) {
      const lookup = lookups.get(pid) ?? { kind: 'failed' };
      for (const resolve of waiters) resolve(lookup);
    }
  }
}

const sharedBatcher = new WindowsStartTimeBatcher();

/** 既定の経路。 プロセス内の照合はすべてこの 1 つの batcher に相乗りする。 */
export function readWindowsStartTime(pid: number): Promise<WindowsStartTimeLookup> {
  return sharedBatcher.read(pid);
}
