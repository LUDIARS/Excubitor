import { describe, it, expect } from 'vitest';
import { parseDockerStats, parseMemUsage, parsePercent } from './docker-sampler.js';

describe('parseMemUsage', () => {
  it('"used / limit" をバイトへ分解', () => {
    expect(parseMemUsage('123.4MiB / 7.5GiB')).toEqual({
      used: Math.round(123.4 * 1024 ** 2),
      limit: Math.round(7.5 * 1024 ** 3),
    });
  });
  it('limit 欠落でも used を返す', () => {
    expect(parseMemUsage('10MiB').used).toBe(10 * 1024 ** 2);
  });
});

describe('parsePercent', () => {
  it('"12.34%" → 12.34', () => {
    expect(parsePercent('12.34%')).toBe(12.34);
    expect(parsePercent('0.00%')).toBe(0);
  });
  it('非数値は null', () => {
    expect(parsePercent('--')).toBeNull();
  });
});

describe('parseDockerStats', () => {
  it('NDJSON 各行から name/used/limit/percent を取る', () => {
    const raw = [
      JSON.stringify({ Name: 'cernere-backend-dev', Container: 'abc123', MemUsage: '256MiB / 4GiB', MemPerc: '6.25%' }),
      JSON.stringify({ Name: '/actio-backend-1', Container: 'def456', MemUsage: '1.2GiB / 8GiB', MemPerc: '15.00%' }),
      'garbage',
    ].join('\n');
    const stats = parseDockerStats(raw);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({
      name: 'cernere-backend-dev',
      usedBytes: 256 * 1024 ** 2,
      percent: 6.25,
    });
    // 先頭スラッシュは除去
    expect(stats[1]!.name).toBe('actio-backend-1');
  });
});
