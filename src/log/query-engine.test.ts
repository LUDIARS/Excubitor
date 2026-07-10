import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { queryLogs } from './query-engine.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excubitor-log-query-'));
  roots.push(root);
  return root;
}

function writeLogs(root: string, code: string, date: string, rows: Array<Record<string, unknown>>): void {
  const serviceDir = path.join(root, code);
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(
    path.join(serviceDir, `${date}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{"ts":`,
    'utf8',
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('queryLogs', () => {
  it('日付で JSONL を絞り、level・contains・code を適用する', async () => {
    const root = makeRoot();
    const first = Date.parse('2026-01-02T00:00:01Z');
    const second = Date.parse('2026-01-02T00:00:02Z');
    writeLogs(root, 'alpha', '2026-01-02', [
      { ts: first, level: 'info', service: 'alpha', channel: 'app', msg: 'started' },
      { ts: second, level: 'error', service: 'alpha', channel: 'stderr', msg: 'Needle failed' },
    ]);
    writeLogs(root, 'beta', '2026-01-02', [
      { ts: second + 1, level: 'error', service: 'beta', channel: 'app', msg: 'Needle elsewhere' },
    ]);

    const logs = await queryLogs(root, {
      codes: ['alpha'],
      from: Date.parse('2026-01-02T00:00:00Z'),
      to: Date.parse('2026-01-02T23:59:59Z'),
      level: 'error',
      contains: 'needle',
      limit: 5,
    });

    expect(logs).toEqual([{
      code: 'alpha',
      ts: second,
      level: 'error',
      channel: 'stderr',
      line: 'Needle failed',
    }]);
  });

  it('対象ファイルが無ければ空配列を返す', async () => {
    const logs = await queryLogs(makeRoot(), { from: 0, to: 1, limit: 10 });
    expect(logs).toEqual([]);
  });

  it('空の当日 JSONL を無視する', async () => {
    const root = makeRoot();
    const serviceDir = path.join(root, 'empty');
    fs.mkdirSync(serviceDir);
    fs.writeFileSync(path.join(serviceDir, '2026-01-02.jsonl'), '', 'utf8');

    const logs = await queryLogs(root, {
      from: Date.parse('2026-01-02T00:00:00Z'),
      to: Date.parse('2026-01-02T23:59:59Z'),
      limit: 10,
    });
    expect(logs).toEqual([]);
  });
});
