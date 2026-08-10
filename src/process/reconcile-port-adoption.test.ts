import { describe, expect, it, vi } from 'vitest';
import { adoptDeclaredPortOwners, type PortAdoptionDeps, type ReconcileResult } from './reconcile.js';
import type { Catalog } from '../catalog/loader.js';

function catalogWith(services: Array<{
  code: string;
  port?: number;
  frontend_port?: number;
  backend_port?: number;
  ports?: Array<{ role: string; port: number }>;
}>): Catalog {
  return { services } as unknown as Catalog;
}

function emptyResult(): ReconcileResult {
  return { adopted: [], crashed: [], adoptedByPort: [] };
}

function deps(overrides: Partial<PortAdoptionDeps> = {}): PortAdoptionDeps {
  return {
    listeners: async () => [{ port: 11111, pids: [32456] }],
    isAlive: () => true,
    identity: async (pid) => ({ pid, startedAt: new Date('2026-08-10T00:00:00.000Z'), verified: true }),
    adopt: vi.fn(),
    managed: () => false,
    pidManaged: () => false,
    persist: vi.fn(),
    ...overrides,
  };
}

describe('adoptDeclaredPortOwners', () => {
  // 2026-08-10 の concordia: Excubitor は stopped / pid=null と信じたまま、実体は
  // 宣言ポートを保持して稼働していた。pid の記録が消えると再採用の入口が無くなる。
  it('adopts a live process holding the declared port when no pid record survived', async () => {
    const adopt = vi.fn();
    const persist = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, persist }),
    );

    expect(result.adoptedByPort).toEqual(['concordia']);
    expect(adopt).toHaveBeenCalledWith('concordia', expect.objectContaining({ pid: 32456 }));
    expect(persist).toHaveBeenCalledWith(
      'concordia',
      expect.objectContaining({ pid: 32456, startedAt: new Date('2026-08-10T00:00:00.000Z') }),
    );
  });

  it('leaves an already managed service alone', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, managed: () => true }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('ignores a declared port that nobody is listening on', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, listeners: async () => [{ port: 4240, pids: [1] }] }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  // pid が死んでいるのに adopt すると、停止も再起動も存在しない対象へ向かう。
  it('skips a dead pid reported by the listener scan', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, isAlive: () => false }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  // ポート走査は補助手段。読めなくても通常の pid 突合の結果を壊さない。
  it('survives a listener scan failure without adopting anything', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, listeners: async () => { throw new Error('netstat unavailable'); } }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('ignores services that declare no port', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'hora-app' }]),
      new Set(['hora-app']),
      result,
      deps({ adopt }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('uses ports declared through the managed ports collection', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', ports: [{ role: 'control', port: 11111 }] }]),
      new Set(['concordia']),
      result,
      deps({ adopt }),
    );

    expect(result.adoptedByPort).toEqual(['concordia']);
    expect(adopt).toHaveBeenCalledWith('concordia', expect.objectContaining({ pid: 32456 }));
  });

  it('does not guess when multiple services declare the same port', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([
        { code: 'concordia', port: 11111 },
        { code: 'concordia-develop', port: 11111 },
      ]),
      new Set(['concordia', 'concordia-develop']),
      result,
      deps({ adopt }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('does not guess when a legacy port conflicts with a managed ports entry', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([
        { code: 'concordia', port: 11111 },
        { code: 'other', ports: [{ role: 'api', port: 11111 }] },
      ]),
      new Set(['concordia', 'other']),
      result,
      deps({ adopt }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('does not guess when multiple live processes own the declared port', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, listeners: async () => [{ port: 11111, pids: [32456, 32457] }] }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('does not adopt a pid already managed under another service', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, pidManaged: (pid) => pid === 32456 }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('does not assign one pid to multiple service codes', async () => {
    const adopt = vi.fn();
    const result = emptyResult();
    const listeners = async () => [
      { port: 11111, pids: [32456] },
      { port: 11112, pids: [32456] },
    ];

    await adoptDeclaredPortOwners(
      catalogWith([
        { code: 'concordia', port: 11111 },
        { code: 'other', port: 11112 },
      ]),
      new Set(['concordia', 'other']),
      result,
      deps({ adopt, listeners }),
    );

    expect(result.adoptedByPort).toEqual(['concordia']);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a service managed while listener identity is being read', async () => {
    const adopt = vi.fn();
    const persist = vi.fn();
    const managed = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, persist, managed }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it('contains an identity read failure to the affected candidate', async () => {
    const adopt = vi.fn();
    const result = emptyResult();

    await expect(adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, identity: async () => { throw new Error('access denied'); } }),
    )).resolves.toBeUndefined();

    expect(result.adoptedByPort).toEqual([]);
    expect(adopt).not.toHaveBeenCalled();
  });

  it('does not adopt a stale listener PID that no longer owns the port', async () => {
    const adopt = vi.fn();
    const persist = vi.fn();
    const listeners = vi.fn()
      .mockResolvedValueOnce([{ port: 11111, pids: [32456] }])
      .mockResolvedValueOnce([{ port: 11111, pids: [99999] }]);
    const result = emptyResult();

    await adoptDeclaredPortOwners(
      catalogWith([{ code: 'concordia', port: 11111 }]),
      new Set(['concordia']),
      result,
      deps({ adopt, persist, listeners }),
    );

    expect(result.adoptedByPort).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });
});
