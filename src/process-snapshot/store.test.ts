import { afterEach, describe, expect, it } from 'vitest';
import { buildProcessSnapshotRouter } from './router.js';
import { clearProcessSnapshot, getProcessSnapshot, publishProcessSnapshot } from './store.js';

afterEach(() => clearProcessSnapshot());

describe('process snapshot store/router', () => {
  it('採取前は 503、採取後は共有スナップショットを返す', async () => {
    const app = buildProcessSnapshotRouter();
    expect((await app.request('/api/v1/processes/snapshot')).status).toBe(503);

    const sampledAt = Date.now();
    publishProcessSnapshot([{
      pid: 10,
      ppid: 1,
      rss: 2048,
      cpuMs: 15,
      name: 'node.exe',
      startedAt: 1234,
      commandLine: 'node lictor.mjs',
    }], sampledAt);

    const response = await app.request('/api/v1/processes/snapshot');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sampled_at: sampledAt,
      processes: [{
        pid: 10,
        ppid: 1,
        rss: 2048,
        cpu_ms: 15,
        name: 'node.exe',
        started_at: 1234,
        command_line: 'node lictor.mjs',
      }],
    });
  });

  it('古すぎる snapshot は API へ返さない', async () => {
    publishProcessSnapshot([{ pid: 10, ppid: 1, rss: 100 }], 1);
    expect((await buildProcessSnapshotRouter().request('/api/v1/processes/snapshot')).status).toBe(503);
  });

  it('入力配列・要素を複製して保持する', () => {
    const input = [{ pid: 10, ppid: 1, rss: 100 }];
    publishProcessSnapshot(input, 1);
    input[0]!.rss = 999;
    input.push({ pid: 20, ppid: 1, rss: 200 });
    expect(getProcessSnapshot()?.processes).toEqual([{ pid: 10, ppid: 1, rss: 100 }]);
  });
});
