import { describe, expect, it } from 'vitest';
import { LogRingBuffer } from './ring-buffer.js';

function line(code: string, value: string, timestamp: number, channel: 'stdout' | 'stderr' = 'stdout') {
  return { service_code: code, channel, ts: new Date(timestamp), line: value };
}

describe('LogRingBuffer', () => {
  it('サービス別と全体の上限を保ち、新しい順で返す', () => {
    const buffer = new LogRingBuffer({ perService: 2, global: 3 });
    buffer.append(line('a', 'one', 1));
    buffer.append(line('b', 'two', 2));
    buffer.append(line('a', 'warn three', 3));
    buffer.append(line('a', 'four', 4, 'stderr'));

    expect(buffer.recent({ limit: 10 }).map((entry) => entry.line)).toEqual(['four', 'warn three', 'two']);
    expect(buffer.recentForService('a', 10).map((entry) => entry.line)).toEqual(['four', 'warn three']);
    expect(buffer.recentForService('a', 10).map((entry) => entry.level)).toEqual(['error', 'warn']);
  });

  it('codes filter と再設定後の容量を適用する', () => {
    const buffer = new LogRingBuffer({ perService: 3, global: 4 });
    buffer.append(line('a', 'a1', 1));
    buffer.append(line('b', 'b1', 2));
    buffer.append(line('a', 'a2', 3));
    buffer.configure({ perService: 1, global: 2 });

    expect(buffer.recent({ codes: new Set(['a']), limit: 10 }).map((entry) => entry.line)).toEqual(['a2']);
    expect(buffer.recentForService('a', 10).map((entry) => entry.line)).toEqual(['a2']);
  });
});
