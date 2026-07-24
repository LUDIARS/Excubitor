import { Hono } from 'hono';
import { getFreshProcessSnapshot } from './store.js';

/**
 * localhost のサービス間共有用。command line を含むため外部公開せず、
 * Excubitor 自身の loop が採取したキャッシュだけを返す。
 */
export function buildProcessSnapshotRouter(): Hono {
  const app = new Hono();

  app.get('/api/v1/processes/snapshot', (c) => {
    const snapshot = getFreshProcessSnapshot();
    if (!snapshot) {
      return c.json({ error: 'process_snapshot_unavailable' }, 503);
    }
    return c.json({
      sampled_at: snapshot.sampledAt,
      processes: snapshot.processes.map((process) => ({
        pid: process.pid,
        ppid: process.ppid,
        rss: process.rss,
        cpu_ms: process.cpuMs ?? null,
        name: process.name ?? '',
        started_at: process.startedAt ?? null,
        command_line: process.commandLine ?? '',
      })),
    });
  });

  return app;
}
