/** @implements SPEC-EX-DNS-FILTER */
import { describe, expect, it } from 'vitest';
import { ClientPolicy } from './client-policy.js';
import { DomainSet } from './domain-rules.js';
import { QueryLog } from './query-log.js';
import { DnsFilterResolver, type ResolvedAnswer } from './resolver.js';
import { buildQueryPacket, buildResponsePacket } from './test-packets.js';
import type { Forwarder } from './upstream.js';

function setup(forward: Forwarder, maxInFlight = 8) {
  const log = new QueryLog(50);
  const answers: ResolvedAnswer[] = [];
  const resolver = new DnsFilterResolver({
    rules: () => ({
      allowed: new DomainSet(['ok.tracker.example']),
      blocked: [{ source: 'api', set: new DomainSet(['tracker.example']) }],
    }),
    clients: ClientPolicy.build([]),
    forward,
    log,
    maxInFlight,
    now: () => 1_000,
    onAnswer: (answer) => answers.push(answer),
  });
  return { resolver, log, answers };
}

const local = { address: '127.0.0.1', transport: 'udp' as const };
const rcodeOf = (response: Buffer | null) => response === null ? null : response.readUInt16BE(2) & 0x0f;

describe('DnsFilterResolver', () => {
  it('規則に当たる名前は上流へ渡さず NXDOMAIN を返す', async () => {
    let forwarded = 0;
    const { resolver, log } = setup(async () => { forwarded += 1; return Buffer.alloc(0); });
    const response = await resolver.handle(buildQueryPacket('cdn.tracker.example'), local);
    expect(rcodeOf(response)).toBe(3);
    expect(forwarded).toBe(0);
    expect(log.recent(1)[0]).toMatchObject({ name: 'cdn.tracker.example', type: 'A', action: 'blocked', rule: 'tracker.example', source: 'api', rcode: 3 });
  });

  it('許可に当たる名前と規則外の名前は中継し、 応答をそのまま返して名前の対応を渡す', async () => {
    const upstream = buildResponsePacket('ok.tracker.example', 1, [{ type: 1, data: '203.0.113.7' }]);
    const { resolver, log, answers } = setup(async (query, transport) => {
      expect(transport).toBe('tcp');
      expect(query.readUInt16BE(0)).toBe(0x1234);
      return upstream;
    });
    const response = await resolver.handle(buildQueryPacket('ok.tracker.example'), { address: '192.168.1.5', transport: 'tcp' });
    expect(response).toBe(upstream);
    expect(answers).toEqual([{ name: 'ok.tracker.example', addresses: ['203.0.113.7'] }]);
    expect(log.recent(1)[0]).toMatchObject({ action: 'allowed', rule: 'ok.tracker.example', source: 'allowlist', rcode: 0, client: '192.168.1.5' });
  });

  it('範囲外の相手には答えず、 履歴には残さず数だけ数える', async () => {
    const { resolver, log } = setup(async () => Buffer.alloc(0));
    expect(await resolver.handle(buildQueryPacket('example.com'), { address: '203.0.113.9', transport: 'udp' })).toBeNull();
    expect(log.counters).toMatchObject({ total: 1, refused: 1 });
    expect(log.recent(10)).toEqual([]);
  });

  it('上流の失敗・不正な応答は SERVFAIL', async () => {
    const failing = setup(async () => { throw new Error('timeout'); });
    expect(rcodeOf(await failing.resolver.handle(buildQueryPacket('example.com'), local))).toBe(2);
    expect(failing.log.recent(1)[0]).toMatchObject({ action: 'failed', detail: 'timeout' });
    const spoofed = setup(async () => buildResponsePacket('other.example', 1, [{ type: 1, data: '198.51.100.1' }]));
    expect(rcodeOf(await spoofed.resolver.handle(buildQueryPacket('example.com'), local))).toBe(2);
    expect(spoofed.answers).toEqual([]);
  });

  it('読めない問い合わせは FORMERR (ヘッダも読めなければ答えない)、 標準以外の opcode は NOTIMP', async () => {
    const { resolver, log } = setup(async () => Buffer.alloc(0));
    expect(rcodeOf(await resolver.handle(buildQueryPacket('example.com').subarray(0, 14), local))).toBe(1);
    expect(await resolver.handle(Buffer.alloc(4), local)).toBeNull();
    expect(rcodeOf(await resolver.handle(buildQueryPacket('example.com', 1, 7, 2), local))).toBe(4);
    expect(log.counters.malformed).toBe(2);
  });

  it('同時に中継できる数を超えたら SERVFAIL', async () => {
    let release: () => void = () => undefined;
    const upstream = buildResponsePacket('slow.example', 1, []);
    const { resolver } = setup(() => new Promise((done) => { release = () => done(upstream); }), 1);
    const first = resolver.handle(buildQueryPacket('slow.example'), local);
    expect(resolver.pending).toBe(1);
    expect(rcodeOf(await resolver.handle(buildQueryPacket('slow.example'), local))).toBe(2);
    release();
    expect(await first).toBe(upstream);
    expect(resolver.pending).toBe(0);
  });
});

describe('QueryLog', () => {
  it('上限を超えたら古いものから捨て、 新しい順に返す', () => {
    const log = new QueryLog(3);
    for (const name of ['a', 'b', 'c', 'd']) {
      log.add({ atMs: 0, client: '127.0.0.1', transport: 'udp', name, type: 'A', action: 'allowed', rule: null, source: null, rcode: 0, detail: null, elapsedMs: 0 });
    }
    expect(log.recent(10).map((record) => record.name)).toEqual(['d', 'c', 'b']);
    expect(log.recent(10, (record) => record.name !== 'c').map((record) => record.name)).toEqual(['d', 'b']);
    log.resize(2);
    expect(log.recent(10).map((record) => record.name)).toEqual(['d', 'c']);
    log.add({ atMs: 0, client: '127.0.0.1', transport: 'udp', name: 'e', type: 'A', action: 'blocked', rule: 'e', source: 'api', rcode: 3, detail: null, elapsedMs: 0 });
    expect(log.recent(10).map((record) => record.name)).toEqual(['e', 'd']);
    expect(log.counters).toMatchObject({ total: 5, allowed: 4, blocked: 1 });
  });
});
