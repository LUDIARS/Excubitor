import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRecord, recent, search, lastSeenAt, listFiles } from './vestigium-reader.js';

const dirs: string[] = [];
function makeLogPath(): string {
  const d = path.join(os.tmpdir(), 'vestigium-reader-test-' + Math.random().toString(36).slice(2, 10));
  fs.mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}

function writeJsonl(dir: string, ymd: string, records: Array<Record<string, unknown>>): void {
  fs.writeFileSync(
    path.join(dir, `${ymd}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
}

afterEach(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
  dirs.length = 0;
});

describe('vestigium-reader', () => {
  it('parseRecord accepts valid entries', () => {
    const r = parseRecord(JSON.stringify({
      ts: 1, level: 'info', service: 'svc', channel: 'app', msg: 'hi',
    }));
    expect(r?.msg).toBe('hi');
  });

  it('parseRecord rejects malformed entries', () => {
    expect(parseRecord('not-json')).toBeNull();
    expect(parseRecord('{"foo":1}')).toBeNull();
  });

  it('listFiles returns YYYY-MM-DD files in reverse order', () => {
    const d = makeLogPath();
    writeJsonl(d, '2026-01-01', [{ ts: 1, level: 'info', service: 'x', msg: 'a' }]);
    writeJsonl(d, '2026-01-02', [{ ts: 2, level: 'info', service: 'x', msg: 'b' }]);
    fs.writeFileSync(path.join(d, 'random.txt'), 'ignored');
    const files = listFiles(d);
    expect(files.length).toBe(2);
    expect(files[0]).toMatch(/2026-01-02\.jsonl$/);
    expect(files[1]).toMatch(/2026-01-01\.jsonl$/);
  });

  it('recent returns latest first with limit', () => {
    const d = makeLogPath();
    writeJsonl(d, '2026-01-01', [
      { ts: 1, level: 'info', service: 'x', channel: 'app', msg: 'one' },
      { ts: 2, level: 'info', service: 'x', channel: 'app', msg: 'two' },
      { ts: 3, level: 'info', service: 'x', channel: 'app', msg: 'three' },
    ]);
    const r = recent({ logPath: d, limit: 2 });
    expect(r.map((x) => x.msg)).toEqual(['three', 'two']);
  });

  it('recent filters by level', () => {
    const d = makeLogPath();
    writeJsonl(d, '2026-01-01', [
      { ts: 1, level: 'info', service: 'x', channel: 'app', msg: 'a' },
      { ts: 2, level: 'error', service: 'x', channel: 'app', msg: 'b' },
      { ts: 3, level: 'warn', service: 'x', channel: 'app', msg: 'c' },
    ]);
    const r = recent({ logPath: d, level: ['error', 'fatal'], limit: 10 });
    expect(r.map((x) => x.msg)).toEqual(['b']);
  });

  it('search filters cross-service by regex', () => {
    const a = makeLogPath();
    const b = makeLogPath();
    writeJsonl(a, '2026-01-01', [
      { ts: 1, level: 'info', service: 'a', channel: 'app', msg: 'apple' },
      { ts: 2, level: 'info', service: 'a', channel: 'app', msg: 'banana' },
    ]);
    writeJsonl(b, '2026-01-01', [
      { ts: 3, level: 'info', service: 'b', channel: 'app', msg: 'cherry' },
      { ts: 4, level: 'info', service: 'b', channel: 'app', msg: 'apple pie' },
    ]);
    const hits = search({
      logPaths: [{ code: 'a', logPath: a }, { code: 'b', logPath: b }],
      pattern: 'apple',
    });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => /apple/i.test(h.msg))).toBe(true);
  });

  it('lastSeenAt returns the latest ts', () => {
    const d = makeLogPath();
    writeJsonl(d, '2026-01-01', [
      { ts: 1000, level: 'info', service: 'x', channel: 'app', msg: 'old' },
      { ts: 2000, level: 'info', service: 'x', channel: 'app', msg: 'new' },
    ]);
    expect(lastSeenAt(d)).toBe(2000);
  });

  it('lastSeenAt returns null when no files', () => {
    const d = makeLogPath();
    expect(lastSeenAt(d)).toBeNull();
  });
});


