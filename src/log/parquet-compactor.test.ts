import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactPreviousDay, sweepParquetRetention } from './parquet-compactor.js';
import { queryLogs } from './query-engine.js';

const roots: string[] = [];

function makeServiceRoot(code = 'alpha'): { root: string; serviceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excubitor-parquet-'));
  const serviceDir = path.join(root, code);
  fs.mkdirSync(serviceDir, { recursive: true });
  roots.push(root);
  return { root, serviceDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Parquet compaction', () => {
  it('前日 JSONL を ZSTD Parquet へ変換し、行数照合後に正本を削除する', async () => {
    const { root, serviceDir } = makeServiceRoot();
    const first = Date.parse('2026-01-02T01:00:00Z');
    const second = Date.parse('2026-01-02T02:00:00Z');
    const jsonl = path.join(serviceDir, '2026-01-02.jsonl');
    fs.writeFileSync(jsonl, [
      JSON.stringify({ ts: first, level: 'info', service: 'alpha', channel: 'app', msg: 'first' }),
      JSON.stringify({ ts: second, level: 'warn', service: 'alpha', channel: 'app', msg: 'second' }),
      '{"ts":',
    ].join('\n'), 'utf8');

    const summary = await compactPreviousDay(root, Date.parse('2026-01-03T03:00:00Z'));

    expect(summary).toEqual({ date: '2026-01-02', compacted: 1, skipped: 0, failed: 0 });
    expect(fs.existsSync(jsonl)).toBe(false);
    expect(fs.existsSync(path.join(serviceDir, '2026-01-02.parquet'))).toBe(true);
    fs.writeFileSync(
      path.join(serviceDir, '2026-01-03.jsonl'),
      `${JSON.stringify({
        ts: Date.parse('2026-01-03T01:00:00Z'),
        level: 'info',
        service: 'alpha',
        channel: 'app',
        msg: 'current',
      })}\n`,
      'utf8',
    );
    const logs = await queryLogs(root, {
      from: Date.parse('2026-01-02T00:00:00Z'),
      to: Date.parse('2026-01-03T23:59:59Z'),
      limit: 10,
    });
    expect(logs.map((entry) => entry.line)).toEqual(['current', 'second', 'first']);
  });

  it('保持期限より古い Parquet だけを削除する', () => {
    const { root, serviceDir } = makeServiceRoot();
    fs.writeFileSync(path.join(serviceDir, '2026-01-06.parquet'), 'old');
    fs.writeFileSync(path.join(serviceDir, '2026-01-07.parquet'), 'boundary');
    fs.writeFileSync(path.join(serviceDir, '2026-01-08.jsonl'), 'canonical');

    expect(sweepParquetRetention(root, 3, Date.parse('2026-01-10T12:00:00Z'))).toBe(1);
    expect(fs.existsSync(path.join(serviceDir, '2026-01-06.parquet'))).toBe(false);
    expect(fs.existsSync(path.join(serviceDir, '2026-01-07.parquet'))).toBe(true);
    expect(fs.existsSync(path.join(serviceDir, '2026-01-08.jsonl'))).toBe(true);
  });
});
