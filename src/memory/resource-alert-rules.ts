/**
 * 拠点のマシン資源 (ストレージ / メモリ / CPU) のアラート判定 (pure)。
 *
 * 判定結果は federation の health 応答に載り、 本社の Excubitor がピア巡回で受け取って通知する
 * (拠点は外へ出られない前提なので、 拠点から本社へは送らない)。
 * CPU とメモリは瞬間値で鳴らさず、 観測窓内で閾値超えが続いた割合で判定する (cpu-alert.ts と同じ規則)。
 */

import { detectSustainedCpu, type CpuSample } from './cpu-alert.js';

export type ResourceAlertKind = 'disk' | 'memory' | 'cpu';
export type ResourceAlertLevel = 'warn' | 'critical';

export interface ResourceAlert {
  /** 同じ事象を識別するキー (`disk:<path>` / `memory` / `cpu`)。 通知の重複排除に使う。 */
  key: string;
  kind: ResourceAlertKind;
  level: ResourceAlertLevel;
  /** 人が読む 1 行 (通知本文にそのまま使う)。 */
  message: string;
  /** 判定に使った値 (disk は空き %、 memory / cpu は使用 %)。 */
  value_pct: number;
  threshold_pct: number;
}

export interface DiskUsage {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

export interface PctSample {
  t: number;
  pct: number;
}

export interface ResourceAlertRules {
  diskFreeWarnPct: number;
  diskFreeCriticalPct: number;
  memoryWarnPct: number;
  memoryCriticalPct: number;
  memoryWindowMs: number;
  cpuThresholdPct: number;
  cpuWindowMs: number;
  sustainedRatio: number;
  minSamples: number;
}

export interface ResourceAlertInput {
  disks: DiskUsage[];
  memory: PctSample[];
  cpu: CpuSample[];
}

export function evaluateResourceAlerts(input: ResourceAlertInput, rules: ResourceAlertRules): ResourceAlert[] {
  return [
    ...input.disks.flatMap((disk) => diskAlert(disk, rules)),
    ...memoryAlert(input.memory, rules),
    ...cpuAlert(input.cpu, rules),
  ];
}

function diskAlert(disk: DiskUsage, rules: ResourceAlertRules): ResourceAlert[] {
  if (!(disk.totalBytes > 0)) return [];
  const freePct = round1((disk.freeBytes / disk.totalBytes) * 100);
  if (freePct >= rules.diskFreeWarnPct) return [];
  const critical = freePct < rules.diskFreeCriticalPct;
  const threshold = critical ? rules.diskFreeCriticalPct : rules.diskFreeWarnPct;
  return [{
    key: 'disk:' + disk.path,
    kind: 'disk',
    level: critical ? 'critical' : 'warn',
    message: `ストレージ残り ${freePct}% (${formatGiB(disk.freeBytes)} / ${formatGiB(disk.totalBytes)}) ${disk.path}`,
    value_pct: freePct,
    threshold_pct: threshold,
  }];
}

function memoryAlert(samples: PctSample[], rules: ResourceAlertRules): ResourceAlert[] {
  const result = detectSustainedCpu(toSamples(samples), {
    windowMs: rules.memoryWindowMs,
    thresholdPct: rules.memoryWarnPct,
    sustainedRatio: rules.sustainedRatio,
    minSamples: rules.minSamples,
  });
  if (result.verdict !== 'high') return [];
  const critical = result.avgPct >= rules.memoryCriticalPct;
  return [{
    key: 'memory',
    kind: 'memory',
    level: critical ? 'critical' : 'warn',
    message: `メモリ使用率 平均 ${result.avgPct}% / 最大 ${result.maxPct}% (${minutes(rules.memoryWindowMs)} 分間)`,
    value_pct: result.avgPct,
    threshold_pct: critical ? rules.memoryCriticalPct : rules.memoryWarnPct,
  }];
}

function cpuAlert(samples: CpuSample[], rules: ResourceAlertRules): ResourceAlert[] {
  const result = detectSustainedCpu(samples, {
    windowMs: rules.cpuWindowMs,
    thresholdPct: rules.cpuThresholdPct,
    sustainedRatio: rules.sustainedRatio,
    minSamples: rules.minSamples,
  });
  if (result.verdict !== 'high') return [];
  return [{
    key: 'cpu',
    kind: 'cpu',
    level: 'warn',
    message: `CPU 使用率 平均 ${result.avgPct}% / 最大 ${result.maxPct}% (${minutes(rules.cpuWindowMs)} 分間の ${Math.round(result.highRatio * 100)}% が ${rules.cpuThresholdPct}% 以上)`,
    value_pct: result.avgPct,
    threshold_pct: rules.cpuThresholdPct,
  }];
}

function toSamples(samples: PctSample[]): CpuSample[] {
  return samples.map((sample) => ({ t: sample.t, cpu: sample.pct }));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatGiB(bytes: number): string {
  return (Math.round((bytes / 1024 ** 3) * 10) / 10) + ' GiB';
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}
