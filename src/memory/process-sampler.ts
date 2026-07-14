/**
 * host プロセスの RSS サンプリング (Tier1)。
 *
 * Excubitor は `npm run dev` 等を shell 経由で detached spawn するため、 service_instances.pid は
 * シェル/npm ラッパであり、 実際にメモリを食う node 本体はその子孫にいる。 よって 1 回の OS 呼び出しで
 * 全プロセスの (pid, ppid, WorkingSet/RSS) を取得し、 instance pid を根とする部分木の RSS を合算する。
 *
 * heap 内訳 (heapUsed/external) は OS 外から取れないため、 ここでは RSS のみ (= leak の兆候検知に十分)。
 * 内訳は metrics-sampler (Tier2) で各サービスの /metrics から取る。
 */

import { spawn } from 'node:child_process';

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** 常駐セット (Windows=WorkingSetSize, POSIX=RSS) のバイト数。 */
  rss: number;
  /**
   * プロセス起動以降の累積 CPU 時間 (ミリ秒)。 取得できなかった (列が無い) 行では未設定。
   * 単発値ではなく累積カウンタなので、 CPU 使用率は連続 tick 間の delta で算出する (collector)。
   */
  cpuMs?: number;
}

export interface TreeRss {
  rssBytes: number;
  /** 合算対象に含めたプロセス数 (根含む)。 */
  procCount: number;
}

/** Windows の 100ns 単位 CPU 時間 (KernelModeTime+UserModeTime) を ms へ。 */
function ticks100nsToMs(kernel: number, user: number): number {
  return (kernel + user) / 10_000;
}

/**
 * POSIX `ps` の TIME 列 ("[[DD-]HH:]MM:SS") を ms へ。 解釈不能なら null。
 */
export function parsePosixCpuTime(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  let days = 0;
  let rest = s;
  const dash = rest.indexOf('-');
  if (dash >= 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let h = 0;
  let m = 0;
  let sec = 0;
  if (parts.length === 3) [h, m, sec] = parts as [number, number, number];
  else if (parts.length === 2) [m, sec] = parts as [number, number];
  else return null;
  return ((days * 24 + h) * 3600 + m * 60 + sec) * 1000;
}

/**
 * Windows PowerShell CIM の CSV 出力を parse (pure)。
 * 旧形式 "pid,ppid,ws" (3 列) も、 CPU 付き "pid,ppid,ws,kernel100ns,user100ns" (5 列) も受ける。
 * 1 行 = 1 プロセス。 数値化できない行は skip。
 */
export function parseWindowsProcList(raw: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    const rss = Number(cols[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss)) continue;
    const entry: ProcEntry = { pid, ppid, rss };
    if (cols.length >= 5) {
      const kernel = Number(cols[3]);
      const user = Number(cols[4]);
      if (Number.isFinite(kernel) && Number.isFinite(user)) entry.cpuMs = ticks100nsToMs(kernel, user);
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * POSIX `ps -eo pid=,ppid=,rss=[,time=]` の出力を parse (pure)。 rss は KB なので bytes へ換算。
 * 4 列目があれば CPU 時間 (TIME) として cpuMs に載せる。
 */
export function parsePosixProcList(raw: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    const rssKb = Number(cols[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue;
    const entry: ProcEntry = { pid, ppid, rss: rssKb * 1024 };
    if (cols.length >= 4) {
      const cpuMs = parsePosixCpuTime(cols[3]!);
      if (cpuMs != null) entry.cpuMs = cpuMs;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * rootPid を根とする部分木 (自身 + 全子孫) の RSS を合算 (pure)。
 * cycle / 自己参照 (pid===ppid) は visited で防ぐ。 rootPid が存在しなければ {0,0}。
 */
export function sumTreeRss(procs: ProcEntry[], rootPid: number): TreeRss {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (p.ppid !== p.pid) {
      const arr = children.get(p.ppid) ?? [];
      arr.push(p.pid);
      children.set(p.ppid, arr);
    }
  }
  if (!byPid.has(rootPid)) return { rssBytes: 0, procCount: 0 };

  let rssBytes = 0;
  let procCount = 0;
  const visited = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (!entry) continue;
    rssBytes += entry.rss;
    procCount += 1;
    for (const child of children.get(pid) ?? []) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return { rssBytes, procCount };
}

/**
 * rootPid を根とする部分木の 累積 CPU 時間 (ms) を合算 (pure)。 cpuMs を持つプロセスのみ加算する。
 * 木に 1 つも cpuMs が無ければ null (= CPU 計測不能)。 ツリー走査は sumTreeRss と同じく cycle 安全。
 */
export function sumTreeCpu(procs: ProcEntry[], rootPid: number): number | null {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (p.ppid !== p.pid) {
      const arr = children.get(p.ppid) ?? [];
      arr.push(p.pid);
      children.set(p.ppid, arr);
    }
  }
  if (!byPid.has(rootPid)) return null;

  let cpuMs = 0;
  let any = false;
  const visited = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (!entry) continue;
    if (entry.cpuMs != null) {
      cpuMs += entry.cpuMs;
      any = true;
    }
    for (const child of children.get(pid) ?? []) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return any ? cpuMs : null;
}

/**
 * OS から全プロセスの (pid, ppid, rss, cpu) を 1 回で取得する。 失敗時は null (= サンプリング skip)。
 */
export function listProcesses(timeoutMs = 15000): Promise<ProcEntry[] | null> {
  if (process.platform === 'win32') {
    // WorkingSetSize はバイト、 Kernel/UserModeTime は 100ns 単位の累積 CPU 時間。
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { ' +
      "[string]$_.ProcessId + ',' + [string]$_.ParentProcessId + ',' + [string]$_.WorkingSetSize + ',' + " +
      '[string]$_.KernelModeTime + ' + "',' + [string]$_.UserModeTime }";
    return runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs).then(
      (out) => (out == null ? null : parseWindowsProcList(out)),
    );
  }
  return runCapture('ps', ['-eo', 'pid=,ppid=,rss=,time='], timeoutMs).then((out) =>
    out == null ? null : parsePosixProcList(out),
  );
}

/** stdout を集める軽量 spawn。 失敗・timeout・非 0 終了は null。 */
function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false });
    let out = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      done(null);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.on('error', () => done(null));
    proc.on('close', (code) => done(code === 0 ? out : null));
  });
}
