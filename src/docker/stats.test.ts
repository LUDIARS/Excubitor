import { describe, it, expect } from 'vitest';
import { statFromApi } from './stats.js';

describe('statFromApi', () => {
  it('docker CLI と同じ式で mem/cpu を算出', () => {
    const s = statFromApi({
      id: 'abc', name: '/cernere-backend-dev',
      memory_stats: { usage: 300 * 1024 ** 2, limit: 4 * 1024 ** 3, stats: { inactive_file: 44 * 1024 ** 2 } },
      cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 20_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
    });
    expect(s.name).toBe('cernere-backend-dev');
    expect(s.usedBytes).toBe(256 * 1024 ** 2);
    expect(s.limitBytes).toBe(4 * 1024 ** 3);
    expect(s.percent).toBe(6.25);
    expect(s.cpuPercent).toBe(40);
  });
  it('precpu 欠落なら cpu null、 limit 0 なら null', () => {
    const s = statFromApi({ memory_stats: { usage: 10, limit: 0 }, cpu_stats: { cpu_usage: { total_usage: 1 } } });
    expect(s.cpuPercent).toBeNull();
    expect(s.limitBytes).toBeNull();
    expect(s.percent).toBeNull();
  });

  // one-shot 応答では precpu が現在値と同じで sysDelta=0 になる。 ここで 0% を返すと
  // cpu-alert の sustained 判定に偽の低負荷サンプルが混ざるため 「不明」 でなければならない。
  it('system delta が 0 なら 0% ではなく null (不明)', () => {
    const s = statFromApi({
      memory_stats: { usage: 100, limit: 1000 },
      cpu_stats: { cpu_usage: { total_usage: 5_000 }, system_cpu_usage: 10_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 5_000 }, system_cpu_usage: 10_000_000 },
    });
    expect(s.cpuPercent).toBeNull();
  });

  it('cgroup v1 の total_inactive_file も差し引く', () => {
    const s = statFromApi({
      memory_stats: { usage: 300, limit: 1000, stats: { total_inactive_file: 100 } },
    });
    expect(s.usedBytes).toBe(200);
  });

  it('online_cpus 欠落なら 1 コア換算', () => {
    const s = statFromApi({
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 20_000 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
    });
    expect(s.cpuPercent).toBe(10);
  });
});
