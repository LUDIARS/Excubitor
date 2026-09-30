/**
 * 自拠点の資源アラートを周期的に判定し、 メモリに公開する。
 *
 * メモリ監視ループ (loop.ts) の 1 周ごとに呼ばれる。 federation の health 応答はここの
 * 公開値を読むだけで、 要求時に採取しない (Health の絶対ルール)。
 */

import type { Catalog } from '../catalog/loader.js';
import { arsRoot } from '../shared/roots.js';
import {
  evaluateResourceAlerts,
  type PctSample,
  type ResourceAlert,
  type ResourceAlertRules,
} from './resource-alert-rules.js';
import { memoryUsedPct, sampleDisks } from './resource-sampler.js';
import { querySeries, toCpuSamples } from './store.js';

export interface ActiveResourceAlert extends ResourceAlert {
  /** この事象を最初に検知した時刻 (epoch ms)。 */
  since: number;
}

let memorySeries: PctSample[] = [];
let active: ActiveResourceAlert[] = [];
let evaluatedAt: number | null = null;

export function currentResourceAlerts(): { alerts: ActiveResourceAlert[]; evaluated_at: number | null } {
  return { alerts: active, evaluated_at: evaluatedAt };
}

export function resourceAlertRules(catalog: Catalog): ResourceAlertRules {
  const config = catalog.memory_monitor.resource_alert;
  const cpu = catalog.memory_monitor.cpu_alert;
  return {
    diskFreeWarnPct: config.disk_free_warn_pct,
    diskFreeCriticalPct: config.disk_free_critical_pct,
    memoryWarnPct: config.memory_warn_pct,
    memoryCriticalPct: config.memory_critical_pct,
    memoryWindowMs: config.memory_window_min * 60_000,
    cpuThresholdPct: cpu.threshold_pct,
    cpuWindowMs: cpu.window_min * 60_000,
    sustainedRatio: cpu.sustained_ratio,
    minSamples: cpu.min_samples,
  };
}

export async function evaluateLocalResourceAlerts(catalog: Catalog, now = Date.now()): Promise<void> {
  const config = catalog.memory_monitor.resource_alert;
  if (!config.enabled) {
    memorySeries = [];
    active = [];
    evaluatedAt = now;
    return;
  }
  const rules = resourceAlertRules(catalog);
  const memoryPct = await memoryUsedPct();
  const keepSince = now - Math.max(rules.memoryWindowMs, rules.cpuWindowMs);
  memorySeries = [...memorySeries, ...(memoryPct === null ? [] : [{ t: now, pct: memoryPct }])]
    .filter((sample) => sample.t >= keepSince);
  const disks = await sampleDisks(config.disk_paths.length ? config.disk_paths : defaultDiskPaths());
  const cpu = toCpuSamples(querySeries('host', 'host', now - rules.cpuWindowMs, 'host'));
  active = withSince(evaluateResourceAlerts({ disks, memory: memorySeries, cpu }, rules), active, now);
  evaluatedAt = now;
}

/** 続いている事象は最初の検知時刻を引き継ぐ。 */
export function withSince(
  alerts: ResourceAlert[],
  previous: readonly ActiveResourceAlert[],
  now: number,
): ActiveResourceAlert[] {
  const since = new Map(previous.map((alert) => [alert.key, alert.since]));
  return alerts.map((alert) => ({ ...alert, since: since.get(alert.key) ?? now }));
}

function defaultDiskPaths(): string[] {
  return [arsRoot(), process.cwd()];
}
