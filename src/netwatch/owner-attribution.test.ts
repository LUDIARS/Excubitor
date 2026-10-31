/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { ConnectionTable } from './connection-table.js';
import { DestinationStore } from './destination-store.js';
import { OwnerAttribution } from './owner-attribution.js';
import { OwnerResolver } from './owner-resolver.js';

const PROCESSES = [
  { pid: 10, ppid: 1, name: 'supervisor.exe' },
  { pid: 20, ppid: 10, name: 'node.exe' },
  { pid: 30, ppid: 20, name: 'worker.exe' },
  { pid: 40, ppid: 1, name: 'chrome.exe' },
  { pid: 50, ppid: 50, name: 'self-parent.exe' },
];

describe('OwnerResolver', () => {
  const resolver = new OwnerResolver(PROCESSES, [{ code: 'memoria', pid: 20 }]);

  it('サービスの根とその子孫はサービス、 それ以外は null', () => {
    expect(resolver.resolve(20)).toEqual({ pid: 20, name: 'node.exe', service: 'memoria' });
    expect(resolver.resolve(30)).toEqual({ pid: 30, name: 'worker.exe', service: 'memoria' });
    expect(resolver.resolve(40)).toEqual({ pid: 40, name: 'chrome.exe', service: null });
    expect(resolver.resolve(50)).toEqual({ pid: 50, name: 'self-parent.exe', service: null });
  });

  it('一覧に無い pid は名前もサービスも不明 (根そのものならサービス)', () => {
    expect(resolver.resolve(99)).toEqual({ pid: 99, name: null, service: null });
    expect(new OwnerResolver([], [{ code: 'memoria', pid: 20 }]).resolve(20))
      .toEqual({ pid: 20, name: null, service: 'memoria' });
  });
});

describe('OwnerAttribution', () => {
  function setup(): { store: DestinationStore; attribution: OwnerAttribution } {
    const store = new DestinationStore(10, 'JP');
    store.hit({ remote: '203.0.113.5', atMs: 1, kind: 'syn', port: 443, country: null, domains: [] });
    return { store, attribution: new OwnerAttribution(store, { pendingTtlMs: 1_000, maxPending: 2 }) };
  }
  const resolver = new OwnerResolver(PROCESSES, []);
  const tcp = { transport: 'tcp' as const, port: 51234 };
  const chromeRow = { transport: 'tcp' as const, localPort: 51234, remote: '203.0.113.5', pid: 40 };

  it('表に無ければ次の表まで待ち、 現れたらプロセスを付ける', () => {
    const { store, attribution } = setup();
    attribution.observe('203.0.113.5', tcp, 0);
    expect(attribution.pendingCount).toBe(1);
    attribution.refresh(new ConnectionTable([chromeRow]), resolver, 500);
    expect(attribution.pendingCount).toBe(0);
    expect(store.list()[0]?.owners).toEqual([{ pid: 40, name: 'chrome.exe', service: null }]);
    expect(attribution.counters).toEqual({ attributed: 1, expired: 0 });
  });

  it('期限までに現れなければ不明のまま捨て、 上限を超えた分も捨てる', () => {
    const { store, attribution } = setup();
    for (let index = 0; index < 3; index += 1) attribution.observe('203.0.113.5', tcp, 0);
    expect(attribution.pendingCount).toBe(2);
    attribution.refresh(new ConnectionTable([]), resolver, 500);
    expect(attribution.pendingCount).toBe(2);
    attribution.refresh(new ConnectionTable([]), resolver, 1_000);
    expect(attribution.pendingCount).toBe(0);
    expect(attribution.counters).toEqual({ attributed: 0, expired: 3 });
    expect(store.list()[0]?.owners).toEqual([]);
  });

  it('reset の後は古い表で引かない', () => {
    const { store, attribution } = setup();
    attribution.refresh(new ConnectionTable([chromeRow]), resolver, 0);
    attribution.reset();
    attribution.observe('203.0.113.5', tcp, 0);
    expect(store.list()[0]?.owners).toEqual([]);
    expect(attribution.pendingCount).toBe(1);
  });
});
