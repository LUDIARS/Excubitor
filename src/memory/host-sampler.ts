/**
 * ホスト全体 (マシン) のメモリ + CPU サンプリング。
 *
 * 個別サービス (プロセスツリー) とは別軸で「マシン全体」を 1 ターゲットとして監視する。
 * - メモリ: os.totalmem() / os.freemem() (物理メモリ)。
 * - CPU: os.cpus() の累積 tick を 200ms あけて 2 回読み、 delta から全体使用率 (%) を出す
 *   (Concordia の metrics collector と同方式)。
 */

import os from 'node:os';

export interface HostSnapshot {
  totalMemBytes: number;
  usedMemBytes: number;
  freeMemBytes: number;
  cpuCount: number;
  /** 全体 CPU 使用率 0-100、 取得不能なら null。 */
  cpuPct: number | null;
}

/** マシン全体のメモリ + CPU を 1 回採取する。 */
export async function sampleHost(): Promise<HostSnapshot> {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMemBytes: total,
    usedMemBytes: total - free,
    freeMemBytes: free,
    cpuCount: os.cpus().length,
    cpuPct: await cpuLoadPct(),
  };
}

/** os.cpus() の 200ms デルタで全体 CPU 使用率 (%) を測る。 */
export async function cpuLoadPct(): Promise<number | null> {
  try {
    const a = cpuTotals();
    await sleep(200);
    const b = cpuTotals();
    const dt = b.total - a.total;
    const di = b.idle - a.idle;
    if (dt <= 0) return null;
    return Math.round((1 - di / dt) * 1000) / 10; // 小数 1 桁
  } catch {
    return null;
  }
}

/** 全 CPU の (idle, total) tick 合計 (pure に近いが os 依存)。 */
function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times) as Array<keyof typeof c.times>) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
