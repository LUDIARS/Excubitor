/**
 * docker コンテナのメモリサンプリング。
 *
 * `docker stats --no-stream --format '{{json .}}'` を 1 回呼んで全 running コンテナの
 * MemUsage を取得し、 コンテナ名 → バイト数に正規化する。 scanner/docker.ts と同様に
 * NDJSON を parse する。
 */

import { spawn } from 'node:child_process';
import { parseSize } from './units.js';

export interface DockerMemStat {
  /** コンテナ名 (catalog の container_names と突合する)。 */
  name: string;
  container: string;
  usedBytes: number | null;
  limitBytes: number | null;
  /** docker 報告の使用率 (%)、 数値化できなければ null。 */
  percent: number | null;
}

/**
 * `docker stats` の NDJSON 出力を parse (pure)。 各行は { Name, Container, MemUsage, MemPerc } 等。
 * MemUsage は "123.4MiB / 7.5GiB" 形式。
 */
export function parseDockerStats(raw: string): DockerMemStat[] {
  const stats: DockerMemStat[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const o = JSON.parse(line) as Record<string, string>;
      const { used, limit } = parseMemUsage(o.MemUsage ?? '');
      const percent = parsePercent(o.MemPerc ?? '');
      stats.push({
        name: (o.Name ?? '').replace(/^\//, '').trim(),
        container: o.Container ?? '',
        usedBytes: used,
        limitBytes: limit,
        percent,
      });
    } catch {
      // broken line — skip
    }
  }
  return stats;
}

/** "123.4MiB / 7.5GiB" → { used, limit } バイト。 */
export function parseMemUsage(input: string): { used: number | null; limit: number | null } {
  const parts = input.split('/');
  const used = parts[0] ? parseSize(parts[0].trim()) : null;
  const limit = parts[1] ? parseSize(parts[1].trim()) : null;
  return { used, limit };
}

/** "12.34%" → 12.34。 */
export function parsePercent(input: string): number | null {
  const m = input.trim().match(/^([0-9]*\.?[0-9]+)\s*%$/);
  if (!m) return null;
  const v = Number(m[1]);
  return isFinite(v) ? v : null;
}

/** 名前 → stat の Map。 OS 呼び出し失敗時は null。 */
export async function sampleDockerStats(timeoutMs = 15000): Promise<Map<string, DockerMemStat> | null> {
  const out = await runDocker(['stats', '--no-stream', '--format', '{{json .}}'], timeoutMs);
  if (out == null) return null;
  const map = new Map<string, DockerMemStat>();
  for (const s of parseDockerStats(out)) {
    if (s.name) map.set(s.name, s);
  }
  return map;
}

function runDocker(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('docker', args, { shell: false });
    let out = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      done(null);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    proc.on('error', () => done(null));
    proc.on('close', (code) => done(code === 0 ? out : null));
  });
}
