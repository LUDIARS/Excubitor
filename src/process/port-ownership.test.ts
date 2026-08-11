import { describe, expect, it } from 'vitest';

import { classifyPortOwnership } from './port-ownership.js';

const listeners = [
  { port: 11111, pids: [84740], processNames: ['node.exe'] },
  { port: 4240, pids: [1234, 5678], processNames: ['node.exe', 'node.exe'] },
];

function classify(overrides: Partial<Parameters<typeof classifyPortOwnership>[0]> = {}) {
  return classifyPortOwnership({
    port: 11111,
    managedPid: 84740,
    listeners,
    healthOk: true,
    local: true,
    ...overrides,
  });
}

describe('classifyPortOwnership', () => {
  it('trusts health when the managed pid holds the declared port', () => {
    expect(classify()).toEqual({ owner: 'managed', holderPids: [84740], healthTrusted: true, reason: null });
  });

  // 2026-08-08 の実際の状態。 state=crashed / health_ok=true のまま、 別日に起動した
  // 旧プロセスが port を握り続けていた。 ここが 'unmanaged' で healthTrusted=false に
  // ならないと、 見た人は「crashed だが生きている」としか読めない。
  it('distrusts health when an unmanaged process answers on the declared port', () => {
    const result = classify({ managedPid: undefined });
    expect(result.owner).toBe('unmanaged');
    expect(result.holderPids).toEqual([84740]);
    expect(result.healthTrusted).toBe(false);
    expect(result.reason).toContain('管理外');
    expect(result.reason).toContain('pid を把握していない');
  });

  it('names the managed pid when it differs from the holder', () => {
    const result = classify({ managedPid: 999 });
    expect(result.owner).toBe('unmanaged');
    expect(result.reason).toContain('999');
  });

  it('treats any holder pid of the port as managed', () => {
    const result = classify({ port: 4240, managedPid: 5678 });
    expect(result.owner).toBe('managed');
    expect(result.holderPids).toEqual([1234, 5678]);
  });

  it('distrusts a stale ok when nobody listens', () => {
    const result = classify({ port: 9999 });
    expect(result.owner).toBe('free');
    expect(result.healthTrusted).toBe(false);
    expect(result.reason).toContain('観測が古い');
  });

  it('does not complain about a free port when health is not ok', () => {
    expect(classify({ port: 9999, healthOk: false }))
      .toEqual({ owner: 'free', holderPids: [], healthTrusted: true, reason: null });
    expect(classify({ port: 9999, healthOk: null }))
      .toEqual({ owner: 'free', holderPids: [], healthTrusted: true, reason: null });
  });

  // ローカルのリスナー一覧は remote host / docker のサービスについて何も言えない。
  // 判定できないことを 'unmanaged' と混ぜると、 正常な remote が壊れて見える。
  it('stays unknown for anything it cannot observe locally', () => {
    expect(classify({ local: false }).owner).toBe('unknown');
    expect(classify({ port: null }).owner).toBe('unknown');
    expect(classify({ local: false }).healthTrusted).toBe(true);
  });
});
