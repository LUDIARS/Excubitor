import { describe, it, expect } from 'vitest';
import { parseWindowsProcList, parsePosixProcList, sumTreeRss, type ProcEntry } from './process-sampler.js';

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
