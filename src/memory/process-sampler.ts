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
}

export interface TreeRss {
  rssBytes: number;
  /** 合算対象に含めたプロセス数 (根含む)。 */
  procCount: number;
}

/**
 * Windows PowerShell CIM の CSV 出力 ("pid,ppid,ws") を parse (pure)。
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
    entries.push({ pid, ppid, rss });
  }
  return entries;
}

/**
 * POSIX `ps -eo pid=,ppid=,rss=` の出力を parse (pure)。 rss は KB なので bytes へ換算。
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
    entries.push({ pid, ppid, rss: rssKb * 1024 });
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
 * OS から全プロセスの (pid, ppid, rss) を 1 回で取得する。 失敗時は null (= サンプリング skip)。
 */
export function listProcesses(timeoutMs = 15000): Promise<ProcEntry[] | null> {
  if (process.platform === 'win32') {
    // WorkingSetSize はバイト。 ConvertTo-Csv ではなく文字列連結で軽量に出す。
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { ' +
      "[string]$_.ProcessId + ',' + [string]$_.ParentProcessId + ',' + [string]$_.WorkingSetSize }";
    return runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs).then(
      (out) => (out == null ? null : parseWindowsProcList(out)),
    );
  }
  return runCapture('ps', ['-eo', 'pid=,ppid=,rss='], timeoutMs).then((out) =>
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
