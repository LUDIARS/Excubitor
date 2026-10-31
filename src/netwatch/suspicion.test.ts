/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { assessDestination, type SuspicionPolicy } from './suspicion.js';
import type { Destination } from './types.js';

const policy: SuspicionPolicy = { allowedPorts: new Set([53, 80, 443, 853]), trustedDomains: ['example.com'] };

function destination(overrides: Partial<Destination>): Destination {
  return {
    remote: '203.0.113.5', scope: 'public', country: 'US', locality: 'foreign', domains: ['x.example.net'],
    ports: [443], kinds: ['tls'], firstSeenMs: 0, lastSeenMs: 0, packets: 1, owners: [], ...overrides,
  };
}

const chrome = { pid: 40, name: 'chrome.exe', service: null };
const memoria = { pid: 20, name: 'node.exe', service: 'memoria' };

describe('assessDestination', () => {
  it('国外でも名前とよくあるポートがあれば怪しくない', () => {
    expect(assessDestination(destination({ owners: [chrome] }), policy)).toEqual({ services: [], reasons: [] });
  });

  it('名前の無い宛先への直接通信と、 許可外ポートを理由にする', () => {
    expect(assessDestination(destination({ domains: [], ports: [8443], kinds: ['syn'] }), policy).reasons)
      .toEqual(['direct-ip', 'unusual-port']);
  });

  it('すべてサービスの通信なら理由を付けない。 1 つでもサービス以外が混ざれば判定する', () => {
    expect(assessDestination(destination({ domains: [], owners: [memoria] }), policy))
      .toEqual({ services: ['memoria'], reasons: [] });
    expect(assessDestination(destination({ domains: [], owners: [memoria, chrome] }), policy))
      .toEqual({ services: [], reasons: ['direct-ip'] });
  });

  it('信頼するドメイン (配下を含む)・DNS サーバ・公開アドレス以外は怪しいとしない', () => {
    expect(assessDestination(destination({ domains: ['api.example.com'], ports: [22] }), policy).reasons).toEqual([]);
    expect(assessDestination(destination({ domains: [], kinds: ['dns'], ports: [53] }), policy).reasons).toEqual([]);
    expect(assessDestination(destination({ scope: 'private', locality: 'local', domains: [], ports: [22] }), policy).reasons)
      .toEqual([]);
  });
});
