/**
 * Tier2: サービスの heap 内訳サンプリング。
 *
 * RSS だけではリークが JS heap か native (external/arrayBuffers) かを切り分けられない。
 * サービスが catalog の `memory.metrics_url` に process.memoryUsage() 相当の JSON を晒していれば、
 * それを fetch して内訳を取る (opt-in)。 サービス側の規約:
 *   GET <metrics_url> → { rss, heapUsed, heapTotal, external, arrayBuffers }  (各バイト, 数値)
 * いずれのキーも省略可。 失敗 (到達不可 / 非 200 / 非 JSON / timeout) は null。
 */

import type { MemoryMetrics } from './types.js';

export async function fetchMemoryMetrics(url: string, timeoutMs = 4000): Promise<MemoryMetrics | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return normalizeMetrics(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 任意 JSON から既知キーを数値として拾う (pure)。 process.memoryUsage() を
 * { memory: {...} } でネストして返すサービスもあるため一段掘る。
 */
export function normalizeMetrics(json: Record<string, unknown>): MemoryMetrics | null {
  const src =
    json && typeof json === 'object' && json.memory && typeof json.memory === 'object'
      ? (json.memory as Record<string, unknown>)
      : json;
  const pick = (k: string): number | undefined => {
    const v = src[k];
    return typeof v === 'number' && isFinite(v) ? v : undefined;
  };
  const out: MemoryMetrics = {
    rss: pick('rss'),
    heapUsed: pick('heapUsed'),
    heapTotal: pick('heapTotal'),
    external: pick('external'),
    arrayBuffers: pick('arrayBuffers'),
  };
  const hasAny = Object.values(out).some((v) => v !== undefined);
  return hasAny ? out : null;
}
