import { describe, it, expect } from 'vitest';
import {
  parseWindowsProcList,
  parsePosixProcList,
  parsePosixCpuTime,
  sumTreeRss,
  sumTreeCpu,
  type ProcEntry,
} from './process-sampler.js';

describe('parseWindowsProcList', () => {
  it('"pid,ppid,ws" CSV を parse', () => {
    const raw = '100,4,1048576\r\n200,100,2097152\r\nbroken line\r\n300,100,512';
    const entries = parseWindowsProcList(raw);
    expect(entries).toEqual([
      { pid: 100, ppid: 4, rss: 1048576 },
      { pid: 200, ppid: 100, rss: 2097152 },
      { pid: 300, ppid: 100, rss: 512 },
    ]);
  });
});

describe('parsePosixProcList', () => {
  it('ps の rss(KB) を bytes へ換算', () => {
    const raw = '  100   4  1024\n  200 100  2048\n';
    const entries = parsePosixProcList(raw);
    expect(entries).toEqual([
      { pid: 100, ppid: 4, rss: 1024 * 1024 },
      { pid: 200, ppid: 100, rss: 2048 * 1024 },
    ]);
  });
});

describe('sumTreeRss', () => {
  const procs: ProcEntry[] = [
    { pid: 1, ppid: 0, rss: 10 },
    { pid: 100, ppid: 1, rss: 100 }, // shell (root)
    { pid: 200, ppid: 100, rss: 200 }, // npm
    { pid: 300, ppid: 200, rss: 300 }, // node 本体
    { pid: 400, ppid: 300, rss: 400 }, // worker
    { pid: 999, ppid: 1, rss: 999 }, // 無関係
  ];

  it('部分木 (根 + 全子孫) の RSS を合算', () => {
    const r = sumTreeRss(procs, 100);
    expect(r.rssBytes).toBe(100 + 200 + 300 + 400);
    expect(r.procCount).toBe(4);
  });

  it('葉プロセスは自分だけ', () => {
    expect(sumTreeRss(procs, 400)).toEqual({ rssBytes: 400, procCount: 1 });
  });

  it('存在しない pid は 0', () => {
    expect(sumTreeRss(procs, 12345)).toEqual({ rssBytes: 0, procCount: 0 });
  });

  it('cycle (pid===ppid や相互参照) で無限ループしない', () => {
    const cyclic: ProcEntry[] = [
      { pid: 1, ppid: 1, rss: 50 }, // 自己参照
      { pid: 2, ppid: 3, rss: 20 },
      { pid: 3, ppid: 2, rss: 30 }, // 相互参照
    ];
    expect(sumTreeRss(cyclic, 1).rssBytes).toBe(50);
    const r = sumTreeRss(cyclic, 2);
    expect(r.rssBytes).toBe(50); // 2 + 3、 cycle で止まる
    expect(r.procCount).toBe(2);
  });
});

describe('parseWindowsProcList (CPU 列付き)', () => {
  it('5 列 "pid,ppid,ws,kernel100ns,user100ns" で cpuMs を算出', () => {
    // 10,000 (100ns) = 1ms。 kernel=10000 + user=20000 → 3ms。
    const raw = '100,4,1048576,10000,20000';
    expect(parseWindowsProcList(raw)).toEqual([{ pid: 100, ppid: 4, rss: 1048576, cpuMs: 3 }]);
  });
  it('3 列のみなら cpuMs は付かない (後方互換)', () => {
    expect(parseWindowsProcList('100,4,1048576')).toEqual([{ pid: 100, ppid: 4, rss: 1048576 }]);
  });
});

describe('parseWindowsProcList (共有 snapshot JSONL)', () => {
  it('command line の comma と quote を壊さず parse する', () => {
    const raw = JSON.stringify({
      pid: 100,
      ppid: 4,
      rss: 1048576,
      cpu_ms: 3,
      name: 'node.exe',
      started_at: 123456,
      command_line: 'node "a,b.js" --session s1',
    });
    expect(parseWindowsProcList(raw)).toEqual([{
      pid: 100,
      ppid: 4,
      rss: 1048576,
      cpuMs: 3,
      name: 'node.exe',
      startedAt: 123456,
      commandLine: 'node "a,b.js" --session s1',
    }]);
  });
});

describe('parsePosixCpuTime', () => {
  it('MM:SS', () => expect(parsePosixCpuTime('01:30')).toBe(90_000));
  it('HH:MM:SS', () => expect(parsePosixCpuTime('1:00:00')).toBe(3_600_000));
  it('DD-HH:MM:SS', () => expect(parsePosixCpuTime('1-00:00:00')).toBe(86_400_000));
  it('不正は null', () => expect(parsePosixCpuTime('xx')).toBeNull());
});

describe('parsePosixProcList (TIME 列付き)', () => {
  it('4 列目を cpuMs に載せる', () => {
    expect(parsePosixProcList('100 4 1024 00:10')).toEqual([
      { pid: 100, ppid: 4, rss: 1024 * 1024, cpuMs: 10_000 },
    ]);
  });
});

describe('parsePosixProcList (共有 snapshot 列付き)', () => {
  it('etimes/name/args を開始時刻と command line に載せる', () => {
    expect(parsePosixProcList('100 4 1024 00:10 30 node node app.js --flag', 100_000)).toEqual([{
      pid: 100,
      ppid: 4,
      rss: 1024 * 1024,
      cpuMs: 10_000,
      name: 'node',
      startedAt: 70_000,
      commandLine: 'node app.js --flag',
    }]);
  });
});

describe('sumTreeCpu', () => {
  const procs: ProcEntry[] = [
    { pid: 100, ppid: 1, rss: 0, cpuMs: 100 },
    { pid: 200, ppid: 100, rss: 0, cpuMs: 200 },
    { pid: 300, ppid: 200, rss: 0 }, // cpuMs 無し
    { pid: 999, ppid: 1, rss: 0, cpuMs: 999 },
  ];
  it('部分木の cpuMs を合算 (cpuMs 無しは 0 扱い)', () => {
    expect(sumTreeCpu(procs, 100)).toBe(300);
  });
  it('木に cpuMs が 1 つも無ければ null', () => {
    expect(sumTreeCpu([{ pid: 1, ppid: 0, rss: 0 }], 1)).toBeNull();
  });
  it('存在しない pid は null', () => {
    expect(sumTreeCpu(procs, 55555)).toBeNull();
  });
});
