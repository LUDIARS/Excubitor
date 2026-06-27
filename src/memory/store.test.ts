/**
 * 実 SQLite (in-memory) で store.ts の SQL 経路を検証する。
 * fake/deps 注入では列名・FK・予約語・方言の実バグを拾えないため、 実 DB に実走する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb } from '../db/index.js';
import { db } from '../db/client.js';
import {
  insertSamples,
  pruneSamples,
  querySeries,
  latestPerTarget,
  raiseLeakTask,
  toLeakSamples,
} from './store.js';

const INSTANCE_ID = 'inst-1';
const SERVICE_ID = 'svc-1';

beforeAll(() => {
  openDb(':memory:'); // applyMigrations 込み
  // FK を満たすため service + instance を seed。
  db().run(sql`
    INSERT INTO services (id, code, name, catalog_snapshot)
    VALUES (${SERVICE_ID}, 'memoria-server', 'Memoria server', '{}')
  `);
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, pid)
    VALUES (${INSTANCE_ID}, ${SERVICE_ID}, 'running', 4242)
  `);
});

describe('insertSamples / querySeries / latestPerTarget', () => {
  it('service と wsl のサンプルを実 INSERT し列が往復する', () => {
    insertSamples([
      {
        targetKind: 'service',
        targetKey: 'memoria-server',
        serviceInstanceId: INSTANCE_ID,
        source: 'process',
        rssBytes: 256 * 1024 * 1024,
        pid: 4242,
        detail: { procCount: 3 },
      },
      {
        targetKind: 'service',
        targetKey: 'memoria-server',
        serviceInstanceId: INSTANCE_ID,
        source: 'metrics',
        rssBytes: 250 * 1024 * 1024,
        heapUsedBytes: 80 * 1024 * 1024,
        heapTotalBytes: 120 * 1024 * 1024,
        externalBytes: 10 * 1024 * 1024,
        arrayBuffersBytes: 2 * 1024 * 1024,
      },
      {
        targetKind: 'wsl',
        targetKey: 'Ubuntu',
        serviceInstanceId: null,
        source: 'wsl',
        rssBytes: 4 * 1024 * 1024 * 1024,
        detail: { distro: 'Ubuntu', side: 'guest' },
      },
    ]);

    const series = querySeries('service', 'memoria-server', 0, 'process');
    expect(series).toHaveLength(1);
    expect(series[0]!.rss).toBe(256 * 1024 * 1024);

    const metrics = querySeries('service', 'memoria-server', 0, 'metrics');
    expect(metrics[0]!.heap_used).toBe(80 * 1024 * 1024);

    const latest = latestPerTarget();
    // process + metrics + wsl = 3 source 行
    expect(latest.length).toBe(3);
    const wsl = latest.find((r) => r.target_kind === 'wsl');
    expect(wsl?.rss_bytes).toBe(4 * 1024 * 1024 * 1024);
  });

  it('toLeakSamples は rss null を除外', () => {
    const rows = [
      { t: 1, rss: 100, heap_used: null, heap_total: null, external: null, array_buffers: null, cpu: null },
      { t: 2, rss: null, heap_used: null, heap_total: null, external: null, array_buffers: null, cpu: null },
    ];
    expect(toLeakSamples(rows)).toEqual([{ t: 1, rss: 100 }]);
  });

  it('pruneSamples は閾値より古い行を消す', () => {
    const removed = pruneSamples(Date.now() + 60_000); // 未来 → 全削除
    expect(removed).toBeGreaterThanOrEqual(3);
    expect(querySeries('service', 'memoria-server', 0).length).toBe(0);
  });
});

describe('raiseLeakTask', () => {
  it('初回は created、 同一ターゲットの再発は deduped (occurrence_count++)', () => {
    const first = raiseLeakTask({
      serviceInstanceId: INSTANCE_ID,
      dedupPrefix: '[memory-leak] memoria-server',
      summary: '[memory-leak] memoria-server RSS +60MB/h',
    });
    expect(first).toBe('created');

    const second = raiseLeakTask({
      serviceInstanceId: INSTANCE_ID,
      dedupPrefix: '[memory-leak] memoria-server',
      summary: '[memory-leak] memoria-server RSS +70MB/h',
    });
    expect(second).toBe('deduped');

    const rows = db().all(sql`
      SELECT occurrence_count, summary FROM error_tasks WHERE summary LIKE '[memory-leak] memoria-server%'
    `) as Array<{ occurrence_count: number; summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrence_count).toBe(2);
    expect(rows[0]!.summary).toContain('+70MB/h'); // 最新 summary に更新
  });

  it('WSL (instance なし) も独立に起票できる', () => {
    const r = raiseLeakTask({
      serviceInstanceId: null,
      dedupPrefix: '[memory-leak] wsl:Ubuntu',
      summary: '[memory-leak] wsl:Ubuntu RSS +300MB/h',
    });
    expect(r).toBe('created');
  });
});
