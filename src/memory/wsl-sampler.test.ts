import { describe, it, expect } from 'vitest';
import {
  parseDistroList,
  parseMeminfo,
  parseVmmem,
  parseProcStat,
  cpuPctFromStat,
  createWslProbeBreaker,
  isWslProbeAllowed,
  recordWslProbeOutcome,
  WSL_PROBE_COOLDOWN_MS,
  WSL_PROBE_FAILURE_THRESHOLD,
} from './wsl-sampler.js';

describe('parseDistroList', () => {
  it('distro 名を抽出し docker-desktop 系を除外', () => {
    const raw = 'Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nUbuntu-22.04\r\n\r\n';
    expect(parseDistroList(raw)).toEqual(['Ubuntu', 'Ubuntu-22.04']);
  });
  it('既定マーカー (*) を除去', () => {
    expect(parseDistroList('* Ubuntu\nDebian')).toEqual(['Ubuntu', 'Debian']);
  });
  it('rancher-desktop 系 (docker backend distro) を除外', () => {
    const raw = 'Ubuntu\r\nrancher-desktop\r\nrancher-desktop-data\r\n';
    expect(parseDistroList(raw)).toEqual(['Ubuntu']);
  });
});

describe('parseMeminfo', () => {
  it('MemTotal - MemAvailable を used として bytes 換算', () => {
    const raw = [
      'MemTotal:       16384000 kB',
      'MemFree:         1000000 kB',
      'MemAvailable:    4384000 kB',
      'Buffers:          200000 kB',
    ].join('\n');
    const r = parseMeminfo(raw)!;
    expect(r.totalBytes).toBe(16384000 * 1024);
    expect(r.availableBytes).toBe(4384000 * 1024);
    expect(r.usedBytes).toBe((16384000 - 4384000) * 1024);
  });
  it('必須キー欠落は null', () => {
    expect(parseMeminfo('MemTotal: 100 kB')).toBeNull();
  });
});

describe('parseProcStat / cpuPctFromStat', () => {
  it('集計 cpu 行から busy/total を算出 (idle+iowait を除外)', () => {
    // user nice system idle iowait irq softirq steal
    const raw = 'cpu  100 0 50 800 50 0 0 0\ncpu0 50 0 25 400 25 0 0 0\n';
    const r = parseProcStat(raw)!;
    expect(r.total).toBe(100 + 0 + 50 + 800 + 50); // 1000
    expect(r.busy).toBe(1000 - (800 + 50)); // total - (idle+iowait) = 150
  });
  it('cpu 行が無ければ null', () => {
    expect(parseProcStat('intr 123\nctxt 456')).toBeNull();
  });
  it('2 tick の delta から CPU% (busy 増 / total 増)', () => {
    const prev = { busy: 150, total: 1000 };
    const curr = { busy: 150 + 90, total: 1000 + 100 }; // 90/100 = 90%
    expect(cpuPctFromStat(prev, curr)).toBe(90);
  });
  it('時間が進んでいない (dTotal<=0) は null', () => {
    expect(cpuPctFromStat({ busy: 1, total: 10 }, { busy: 1, total: 10 })).toBeNull();
  });
});

describe('parseVmmem', () => {
  it('vmmem 系プロセスの WorkingSet(KB) を合算', () => {
    const raw = [
      '"vmmemWSL","1234","Console","1","2,500,000 K"',
      '"explorer.exe","5678","Console","1","120,000 K"',
      '"vmmem","4321","Console","1","500,000 K"',
    ].join('\r\n');
    const r = parseVmmem(raw);
    expect(r.rssBytes).toBe((2_500_000 + 500_000) * 1024);
    expect(r.procs).toEqual(['vmmemWSL', 'vmmem']);
  });
  it('vmmem 不在なら 0', () => {
    expect(parseVmmem('"explorer.exe","1","Console","1","100 K"')).toEqual({ rssBytes: 0, procs: [] });
  });
});

describe('wsl probe breaker', () => {
  const T0 = 1_700_000_000_000;

  it('初期状態では guest プローブを許可する', () => {
    expect(isWslProbeAllowed(createWslProbeBreaker(), T0)).toBe(true);
  });

  it('閾値未満の連続失敗では開かない', () => {
    let b = createWslProbeBreaker();
    for (let i = 0; i < WSL_PROBE_FAILURE_THRESHOLD - 1; i += 1) {
      b = recordWslProbeOutcome(b, false, T0);
      expect(isWslProbeAllowed(b, T0)).toBe(true);
    }
    expect(b.consecutiveFailures).toBe(WSL_PROBE_FAILURE_THRESHOLD - 1);
  });

  it('連続失敗が閾値に達すると cooldown 分だけ開く', () => {
    let b = createWslProbeBreaker();
    for (let i = 0; i < WSL_PROBE_FAILURE_THRESHOLD; i += 1) b = recordWslProbeOutcome(b, false, T0);
    expect(isWslProbeAllowed(b, T0)).toBe(false);
    // cooldown 中は叩かない = ハンドルも孤児も増えない
    expect(isWslProbeAllowed(b, T0 + WSL_PROBE_COOLDOWN_MS - 1)).toBe(false);
    // 経過後は 1 度だけ試して復帰可否を見る
    expect(isWslProbeAllowed(b, T0 + WSL_PROBE_COOLDOWN_MS)).toBe(true);
  });

  it('成功したら即座に閉じ、 失敗カウントも戻る', () => {
    let b = createWslProbeBreaker();
    for (let i = 0; i < WSL_PROBE_FAILURE_THRESHOLD; i += 1) b = recordWslProbeOutcome(b, false, T0);
    expect(isWslProbeAllowed(b, T0)).toBe(false);

    b = recordWslProbeOutcome(b, true, T0 + WSL_PROBE_COOLDOWN_MS);
    expect(b).toEqual(createWslProbeBreaker());
    expect(isWslProbeAllowed(b, T0 + WSL_PROBE_COOLDOWN_MS)).toBe(true);
  });

  it('開いたまま失敗を重ねても cooldown は現在時刻から引き直される', () => {
    let b = createWslProbeBreaker();
    for (let i = 0; i < WSL_PROBE_FAILURE_THRESHOLD; i += 1) b = recordWslProbeOutcome(b, false, T0);
    const retryAt = T0 + WSL_PROBE_COOLDOWN_MS;
    b = recordWslProbeOutcome(b, false, retryAt);
    expect(isWslProbeAllowed(b, retryAt)).toBe(false);
    expect(isWslProbeAllowed(b, retryAt + WSL_PROBE_COOLDOWN_MS)).toBe(true);
  });
});
