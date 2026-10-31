/** @implements SPEC-EX-DNS-FILTER */
import { describe, expect, it } from 'vitest';
import { decide, DomainSet, normalizeDomain, normalizeDomainList } from './domain-rules.js';

describe('normalizeDomain', () => {
  it('小文字にし、 前の *. と後ろの . を外す', () => {
    expect(normalizeDomain(' *.Tracker.Example.COM. ')).toEqual({ ok: true, domain: 'tracker.example.com' });
    expect(normalizeDomain('xn--eckwd4c7c.xn--zckzah')).toMatchObject({ ok: true });
  });

  it('ドメインとして読めないものは拒否する', () => {
    for (const value of ['', '.', 'a..b', '-a.example', 'a b.example', 'https://example.com', '例え.テスト', 'a'.repeat(64)]) {
      expect(normalizeDomain(value).ok, value).toBe(false);
    }
  });

  it('config の一覧に読めないものがあれば設定エラー', () => {
    expect(() => normalizeDomainList('dns_filter.blocked_domains', ['ok.example', 'bad domain'])).toThrow(/blocked_domains/);
  });
});

describe('DomainSet / decide', () => {
  const book = {
    allowed: new DomainSet(['safe.tracker.example']),
    blocked: [
      { source: 'api' as const, set: new DomainSet(['tracker.example']) },
      { source: 'config' as const, set: new DomainSet(['ads.example']) },
      { source: 'doh' as const, set: new DomainSet(['dns.google']) },
    ],
  };

  it('規則はそのドメインと配下に当たり、 似た名前には当たらない', () => {
    const set = new DomainSet(['example.com']);
    expect(set.match('example.com')).toBe('example.com');
    expect(set.match('a.b.example.com')).toBe('example.com');
    expect(set.match('notexample.com')).toBeNull();
    expect(set.match('com')).toBeNull();
  });

  it('許可が拒否より優先し、 拒否は出どころ順に見る', () => {
    expect(decide('x.safe.tracker.example', book)).toEqual({ action: 'allow', rule: 'safe.tracker.example', source: 'allowlist' });
    expect(decide('cdn.tracker.example', book)).toEqual({ action: 'block', rule: 'tracker.example', source: 'api' });
    expect(decide('ads.example', book)).toEqual({ action: 'block', rule: 'ads.example', source: 'config' });
    expect(decide('dns.google', book)).toEqual({ action: 'block', rule: 'dns.google', source: 'doh' });
    expect(decide('example.org', book)).toEqual({ action: 'allow', rule: null, source: null });
  });
});
