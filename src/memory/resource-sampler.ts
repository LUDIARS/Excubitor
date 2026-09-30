/**
 * 資源アラート用の採取: ディスク空き (statfs) と、 実際に使える空きメモリ。
 *
 * macOS の os.freemem() は未使用ページだけを返し、 キャッシュ (inactive) を含めないため
 * 平常時でも使用率 90% 超に見える。 darwin は vm_stat の free + inactive + speculative を空きとみなす。
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { DiskUsage } from './resource-alert-rules.js';

export async function sampleDisks(paths: readonly string[]): Promise<DiskUsage[]> {
  const unique = [...new Set(paths.filter((path) => path.trim()))];
  const results = await Promise.all(unique.map(async (path): Promise<DiskUsage | null> => {
    try {
      const stats = await statfs(path);
      return { path, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
      return null;
    }
  }));
  return results.filter((usage): usage is DiskUsage => usage !== null);
}

/** 使用中メモリの割合 (%)。 取得できなければ null。 */
export async function memoryUsedPct(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  const total = os.totalmem();
  if (!(total > 0)) return null;
  const available = platform === 'darwin' ? await darwinAvailableBytes() : os.freemem();
  if (available === null) return null;
  return Math.round((1 - Math.min(available, total) / total) * 1000) / 10;
}

async function darwinAvailableBytes(): Promise<number | null> {
  const output = await new Promise<string | null>((resolve) => {
    execFile('vm_stat', [], { timeout: 5_000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout));
  });
  return output === null ? null : parseVmStatAvailableBytes(output);
}

/** `vm_stat` の出力から free + inactive + speculative のバイト数を出す。 */
export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!(pageSize > 0)) return null;
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(output)?.[1] ?? 0);
  const free = /^Pages free:/m.test(output) ? pages('free') : NaN;
  if (!Number.isFinite(free)) return null;
  return (free + pages('inactive') + pages('speculative')) * pageSize;
}
