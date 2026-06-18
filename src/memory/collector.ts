/**
 * メモリ監視の 1 tick: 全ターゲットを採取 → 永続化 → 剪定 → leak 判定 → error_task 起票。
 *
 * OS 呼び出し (プロセス一覧 / docker stats / WSL) は tick あたり 1 回に集約し、 サービス数に対して
 * O(1) のコストに抑える。 サービスは catalog から、 instance/pid は service_instances から解決する。
 */

import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Catalog, Service } from '../catalog/loader.js';
import { listProcesses, sumTreeRss } from './process-sampler.js';
import { sampleDockerStats } from './docker-sampler.js';
import { fetchMemoryMetrics } from './metrics-sampler.js';
import { sampleWsl } from './wsl-sampler.js';
import { detectLeak, type LeakResult } from './leak.js';
import {
  insertSamples,
  pruneSamples,
  querySeries,
  toLeakSamples,
  raiseLeakTask,
} from './store.js';
import type { MemorySample } from './types.js';

const logger = createNamedLogger('excubitor.memory');

interface RunningInstance {
  code: string;
  instanceId: string;
  pid: number | null;
}

function isDockerRuntime(svc: Service): boolean {
  return svc.runtime === 'docker-compose' || svc.runtime === 'docker';
}
function isProcessRuntime(svc: Service): boolean {
  return svc.runtime === 'node' || svc.runtime === 'dev-process-md' || svc.runtime === 'app';
}
function primarySource(svc: Service): 'process' | 'docker' {
  return isDockerRuntime(svc) ? 'docker' : 'process';
}

/** running な instance を code → {instanceId, pid} で引けるよう取得。 */
function loadRunningInstances(): Map<string, RunningInstance> {
  const rows = db().all(sql`
    SELECT s.code AS code, si.id AS instance_id, si.pid AS pid
    FROM services s
    JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1 AND si.state = 'running'
  `) as Array<{ code: string; instance_id: string; pid: number | null }>;
  const map = new Map<string, RunningInstance>();
  for (const r of rows) map.set(r.code, { code: r.code, instanceId: r.instance_id, pid: r.pid });
  return map;
}

export interface CollectResult {
  serviceSamples: number;
  wslSamples: number;
  leaksRaised: number;
}

export async function collectMemoryOnce(catalog: Catalog): Promise<CollectResult> {
  const cfg = catalog.memory_monitor;
  if (!cfg.enabled) return { serviceSamples: 0, wslSamples: 0, leaksRaised: 0 };

  const running = loadRunningInstances();
  const needProcess = catalog.services.some((s) => isProcessRuntime(s) && running.has(s.code));
  const needDocker = catalog.services.some((s) => isDockerRuntime(s) && running.has(s.code));

  // OS 呼び出しは tick あたり 1 回。
  const [procList, dockerStats] = await Promise.all([
    needProcess ? listProcesses() : Promise.resolve(null),
    needDocker ? sampleDockerStats() : Promise.resolve(null),
  ]);

  const samples: MemorySample[] = [];

  for (const svc of catalog.services) {
    if (svc.memory?.enabled === false) continue;
    const inst = running.get(svc.code);
    if (!inst) continue;

    if (isDockerRuntime(svc) && dockerStats && svc.container_names) {
      for (const name of svc.container_names) {
        const stat = dockerStats.get(name);
        if (!stat) continue;
        samples.push({
          targetKind: 'service',
          targetKey: svc.code,
          serviceInstanceId: inst.instanceId,
          source: 'docker',
          rssBytes: stat.usedBytes,
          detail: { container: name, limitBytes: stat.limitBytes, percent: stat.percent },
        });
      }
    } else if (isProcessRuntime(svc) && procList && inst.pid != null) {
      const tree = sumTreeRss(procList, inst.pid);
      samples.push({
        targetKind: 'service',
        targetKey: svc.code,
        serviceInstanceId: inst.instanceId,
        source: 'process',
        rssBytes: tree.rssBytes,
        pid: inst.pid,
        detail: { procCount: tree.procCount },
      });
    }

    // Tier2: heap 内訳 (opt-in)
    if (svc.memory?.metrics_url) {
      const m = await fetchMemoryMetrics(svc.memory.metrics_url);
      if (m) {
        samples.push({
          targetKind: 'service',
          targetKey: svc.code,
          serviceInstanceId: inst.instanceId,
          source: 'metrics',
          rssBytes: m.rss ?? null,
          heapUsedBytes: m.heapUsed ?? null,
          heapTotalBytes: m.heapTotal ?? null,
          externalBytes: m.external ?? null,
          arrayBuffersBytes: m.arrayBuffers ?? null,
        });
      }
    }
  }

  // WSL バックエンド
  let wslSamples: MemorySample[] = [];
  if (cfg.wsl.enabled) {
    try {
      wslSamples = await sampleWsl(cfg.wsl.distros);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'wsl sampling failed');
    }
  }

  const all = [...samples, ...wslSamples];
  insertSamples(all);

  // 剪定
  pruneSamples(Date.now() - cfg.retention_hours * 3_600_000);

  // leak 判定
  const leaksRaised = detectAndRaise(catalog, running);

  logger.debug(
    { serviceSamples: samples.length, wslSamples: wslSamples.length, leaksRaised },
    'memory tick complete',
  );
  return { serviceSamples: samples.length, wslSamples: wslSamples.length, leaksRaised };
}

/** 全ターゲットの leak を判定し leaking なら起票。 起票件数を返す。 */
function detectAndRaise(catalog: Catalog, running: Map<string, RunningInstance>): number {
  let raised = 0;
  const now = Date.now();

  for (const svc of catalog.services) {
    if (svc.memory?.enabled === false) continue;
    const inst = running.get(svc.code);
    if (!inst) continue;
    const windowMin = svc.memory?.leak_window_min ?? 60;
    const thresholdMbPerHr = svc.memory?.leak_threshold_mb_per_hr ?? 50;
    const windowMs = windowMin * 60_000;
    const series = querySeries('service', svc.code, now - windowMs, primarySource(svc));
    const result = detectLeak(toLeakSamples(series), {
      windowMs,
      thresholdBytesPerHour: thresholdMbPerHr * 1024 * 1024,
      minSamples: 8,
    });
    if (result.verdict === 'leaking') {
      const outcome = raiseLeakTask({
        serviceInstanceId: inst.instanceId,
        dedupPrefix: `[memory-leak] ${svc.code}`,
        summary: leakSummary(svc.code, result),
        severity: 'warn',
      });
      if (outcome === 'created') raised += 1;
    }
  }

  if (catalog.memory_monitor.wsl.enabled) {
    const w = catalog.memory_monitor.wsl;
    const windowMs = w.leak_window_min * 60_000;
    const keys = wslTargetKeys(now - windowMs);
    for (const key of keys) {
      const series = querySeries('wsl', key, now - windowMs, 'wsl');
      const result = detectLeak(toLeakSamples(series), {
        windowMs,
        thresholdBytesPerHour: w.leak_threshold_mb_per_hr * 1024 * 1024,
        minSamples: 8,
      });
      if (result.verdict === 'leaking') {
        const outcome = raiseLeakTask({
          serviceInstanceId: null,
          dedupPrefix: `[memory-leak] wsl:${key}`,
          summary: leakSummary(`wsl:${key}`, result),
          severity: 'warn',
        });
        if (outcome === 'created') raised += 1;
      }
    }
  }

  return raised;
}

/** window 内に WSL サンプルがある target_key 一覧。 */
function wslTargetKeys(sinceMs: number): string[] {
  const rows = db().all(sql`
    SELECT DISTINCT target_key FROM memory_samples
    WHERE target_kind = 'wsl' AND sampled_at >= ${sinceMs}
  `) as Array<{ target_key: string }>;
  return rows.map((r) => r.target_key);
}

function leakSummary(label: string, r: LeakResult): string {
  const mbPerHr = (r.slopeBytesPerHour / (1024 * 1024)).toFixed(1);
  const baseMb = ((r.baselineBytes ?? 0) / (1024 * 1024)).toFixed(0);
  const latestMb = ((r.latestBytes ?? 0) / (1024 * 1024)).toFixed(0);
  const spanMin = Math.round(r.spanMs / 60_000);
  return `[memory-leak] ${label} RSS +${mbPerHr}MB/h (${baseMb}→${latestMb}MiB) over ${spanMin}min, ${(r.monotonicRatio * 100).toFixed(0)}% monotonic`;
}
