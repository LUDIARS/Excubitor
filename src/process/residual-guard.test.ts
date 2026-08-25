import { describe, expect, it, vi } from 'vitest';

import { clearResidualServiceProcesses, parseLsofWorkingDirectories } from './residual-guard.js';

describe('parseLsofWorkingDirectories', () => {
  it('lsof -F の pid/cwd を対応付ける', () => {
    expect(parseLsofWorkingDirectories('p100\nfcwd\nna/b\np200\nfcwd\nna/c\n')).toEqual(
      new Map([[100, 'a/b'], [200, 'a/c']]),
    );
  });
});

describe('clearResidualServiceProcesses', () => {
  it('同じ cwd/command の最上位プロセスだけを tree kill する', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const result = await clearResidualServiceProcesses('svc', '/repo', 'npm run start', undefined, {
      kill,
      processes: async () => [
        { pid: 100, ppid: 1, rss: 1, commandLine: '/bin/sh -c npm run start' },
        { pid: 101, ppid: 100, rss: 1, commandLine: 'npm run start' },
        { pid: 200, ppid: 1, rss: 1, commandLine: 'npm run start' },
        { pid: 300, ppid: 1, rss: 1, commandLine: 'npm run other' },
      ],
      workingDirectories: async () => new Map([
        [100, '/repo'], [101, '/repo'], [200, '/other'], [300, '/repo'],
      ]),
    });
    expect(result).toEqual({ stoppedPids: [100] });
    expect(kill).toHaveBeenCalledWith(100);
  });
});
