/**
 * プロセスツリーの 累積 CPU 時間 (cpuMs) から CPU 使用率 (%) を算出する。
 *
 * process-sampler が返す cpuMs は「起動以降の累積」なので、 連続する 2 tick の delta を
 * 実時間 delta で割って瞬間使用率にする。 全マシン比 (cpuCount で正規化) で 0-100% に収める。
 *
 * pid が変わった (= 再起動) / 累積が巻き戻った (pid 再利用) / 初回 tick は null を返す。
 * 状態 (前回 tick) は collector のライフサイクル内で保持する軽量シングルトン。
 */

export interface CpuMark {
  cpuMs: number;
  atMs: number;
  pid: number | null;
}

/**
 * 前回 (prev) と今回 (curr) の累積から CPU% を算出 (pure)。
 * cpuCount で割り全マシン比にする。 異常 (時間が進んでいない / 累積巻き戻り) は null。
 */
export function cpuPctFromDelta(prev: CpuMark, curr: CpuMark, cpuCount: number): number | null {
  const dWall = curr.atMs - prev.atMs;
  const dCpu = curr.cpuMs - prev.cpuMs;
  if (dWall <= 0 || dCpu < 0 || cpuCount <= 0) return null;
  const pct = (dCpu / (dWall * cpuCount)) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10; // 小数 1 桁、 0-100 にクランプ
}

const lastMarks = new Map<string, CpuMark>();

/**
 * key (= サービス code) について今回の累積を記録し、 前回との delta から CPU% を返す。
 * 初回や pid 変化時は記録だけして null。
 */
export function recordAndComputeCpuPct(
  key: string,
  cpuMs: number | null,
  atMs: number,
  pid: number | null,
  cpuCount: number,
): number | null {
  if (cpuMs == null) return null;
  const prev = lastMarks.get(key);
  const curr: CpuMark = { cpuMs, atMs, pid };
  lastMarks.set(key, curr);
  if (!prev) return null;
  if (prev.pid !== pid) return null; // 再起動 → 累積がリセットされている
  return cpuPctFromDelta(prev, curr, cpuCount);
}

/** テスト用: 状態をリセットする。 */
export function resetCpuRateState(): void {
  lastMarks.clear();
}
