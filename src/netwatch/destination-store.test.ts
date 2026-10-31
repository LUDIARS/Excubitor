/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { addressScope } from './address-scope.js';
import { DestinationStore } from './destination-store.js';
import { DnsAnswerCache } from './dns-answer-cache.js';
import { classifyLocality, normalizeCountry } from './locality.js';
import { ObservationIngest } from './observation-ingest.js';
import type { PacketObservation } from './types.js';

function observation(overrides: Partial<PacketObservation>): PacketObservation {
  return { kind: 'syn', atMs: 1_000, remote: '203.0.113.5', port: 443, serverName: null, dns: null, country: null, local: null, ...overrides };
}

describe('addressScope', () => {
  it.each([
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.0.1', 'private'],
    ['100.100.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.1.1', 'link-local'],
    ['224.0.0.251', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'private'],
    ['ff02::fb', 'multicast'],
    ['::ffff:192.168.1.1', 'private'],
    ['2001:4860:4860::8888', 'public'],
  ])('%s は %s', (address, scope) => {
    expect(addressScope(address)).toBe(scope);
  });

  it('IP でない値は null', () => {
    expect(addressScope('example.com')).toBeNull();
  });
});

describe('classifyLocality', () => {
  it('公開アドレスだけを国で判定し、 国不明は unknown のまま', () => {
    expect(classifyLocality('public', 'US', 'JP')).toBe('foreign');
    expect(classifyLocality('public', 'JP', 'JP')).toBe('domestic');
    expect(classifyLocality('public', null, 'JP')).toBe('unknown');
    expect(classifyLocality('private', 'US', 'JP')).toBe('local');
  });

  it('国コードは 2 文字の英字だけを受ける', () => {
    expect(normalizeCountry(' us ')).toBe('US');
    expect(normalizeCountry('USA')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe('DnsAnswerCache', () => {
  it('新しい名前を先頭に、 期限切れは返さない', () => {
    const cache = new DnsAnswerCache(10, 1_000);
    cache.record({ name: 'a.example', addresses: ['203.0.113.5'] }, 0);
    cache.record({ name: 'b.example', addresses: ['203.0.113.5'] }, 100);
    expect(cache.namesFor('203.0.113.5', 200)).toEqual(['b.example', 'a.example']);
    expect(cache.namesFor('203.0.113.5', 1_200)).toEqual([]);
  });

  it('上限を超えたら最後に見たのが古いアドレスから捨てる', () => {
    const cache = new DnsAnswerCache(2, 10_000);
    cache.record({ name: 'one', addresses: ['192.0.2.1'] }, 0);
    cache.record({ name: 'two', addresses: ['192.0.2.2'] }, 1);
    cache.record({ name: 'one-again', addresses: ['192.0.2.1'] }, 2);
    cache.record({ name: 'three', addresses: ['192.0.2.3'] }, 3);
    expect(cache.size).toBe(2);
    expect(cache.namesFor('192.0.2.2', 4)).toEqual([]);
    expect(cache.namesFor('192.0.2.1', 4)).toEqual(['one-again', 'one']);
  });
});

describe('DestinationStore', () => {
  it('同じ宛先を集計し、 国は付かなかった観測で消さない', () => {
    const store = new DestinationStore(10, 'JP');
    store.hit({ remote: '203.0.113.5', atMs: 10, kind: 'syn', port: 443, country: 'US', domains: [] });
    const merged = store.hit({ remote: '203.0.113.5', atMs: 20, kind: 'tls', port: 443, country: null, domains: ['x.example'] });
    expect(merged).toMatchObject({
      country: 'US', locality: 'foreign', domains: ['x.example'], ports: [443], kinds: ['syn', 'tls'],
      firstSeenMs: 10, lastSeenMs: 20, packets: 2,
    });
  });

  it('自国を変えると既存の判定も付け直す', () => {
    const store = new DestinationStore(10, 'JP');
    store.hit({ remote: '203.0.113.5', atMs: 10, kind: 'syn', port: 443, country: 'US', domains: [] });
    store.setHomeCountry('US');
    expect(store.list()[0]?.locality).toBe('domestic');
  });

  it('上限を超えたら最後に見たのが古い宛先から捨て、 IP でない値は捨てる', () => {
    const store = new DestinationStore(2, 'JP');
    store.hit({ remote: '192.0.2.1', atMs: 1, kind: 'syn', port: 1, country: null, domains: [] });
    store.hit({ remote: '192.0.2.2', atMs: 2, kind: 'syn', port: 1, country: null, domains: [] });
    store.hit({ remote: '192.0.2.3', atMs: 3, kind: 'syn', port: 1, country: null, domains: [] });
    expect(store.list().map((destination) => destination.remote)).toEqual(['192.0.2.3', '192.0.2.2']);
    expect(store.hit({ remote: 'not-an-ip', atMs: 4, kind: 'syn', port: 1, country: null, domains: [] })).toBeNull();
  });
});

describe('DestinationStore.addOwner', () => {
  it('同じ pid は先頭へ寄せ直し、 上限 4 件に切り、 知らない宛先には付けない', () => {
    const store = new DestinationStore(10, 'JP');
    store.hit({ remote: '203.0.113.5', atMs: 1, kind: 'syn', port: 443, country: null, domains: [] });
    for (const pid of [1, 2, 3, 4, 5, 2]) store.addOwner('203.0.113.5', { pid, name: `p${pid}.exe`, service: null });
    store.addOwner('198.51.100.1', { pid: 9, name: null, service: null });
    expect(store.list().map((destination) => destination.owners.map((owner) => owner.pid))).toEqual([[2, 5, 4, 3]]);
    // 観測し直しても特定済みのプロセスは消えない。
    store.hit({ remote: '203.0.113.5', atMs: 2, kind: 'tls', port: 443, country: null, domains: ['x.example'] });
    expect(store.list()[0]?.owners).toHaveLength(4);
  });
});

describe('ObservationIngest', () => {
  it('DNS 応答で覚えた名前を、 後から来た接続の宛先に付ける', () => {
    const store = new DestinationStore(10, 'JP');
    const ingest = new ObservationIngest(new DnsAnswerCache(10, 60_000), store);
    ingest.apply(observation({
      kind: 'dns', remote: '8.8.8.8', port: 53, country: 'US',
      dns: { name: 'api.example.com', addresses: ['203.0.113.5'] },
    }));
    const destination = ingest.apply(observation({ atMs: 2_000, country: 'DE' }));
    expect(destination).toMatchObject({ remote: '203.0.113.5', domains: ['api.example.com'], locality: 'foreign' });
    // DNS サーバ自身も通信先として残る (ドメインは付かない)。
    expect(store.list().find((item) => item.remote === '8.8.8.8')).toMatchObject({ domains: [], locality: 'foreign' });
  });

  it('SNI があれば DNS で覚えた名前より優先し、 公開アドレスの国なしを数える', () => {
    const store = new DestinationStore(10, 'JP');
    const ingest = new ObservationIngest(new DnsAnswerCache(10, 60_000), store);
    ingest.apply(observation({ kind: 'dns', remote: '192.168.1.1', dns: { name: 'old.example', addresses: ['203.0.113.5'] } }));
    ingest.apply(observation({ kind: 'tls', serverName: 'new.example' }));
    expect(store.list().find((item) => item.remote === '203.0.113.5')?.domains).toEqual(['new.example']);
    expect(ingest.counters).toEqual({ publicObserved: 1, publicWithoutCountry: 1 });
    ingest.resetCounters();
    expect(ingest.counters).toEqual({ publicObserved: 0, publicWithoutCountry: 0 });
  });
});
