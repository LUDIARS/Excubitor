/** @implements SPEC-EX-DNS-FILTER */
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../catalog/loader.js';
import { ClientPolicy } from './client-policy.js';
import { formatEndpoint, parseEndpoint, parseEndpointList } from './endpoint.js';
import { LISTEN_ENV, resolveDnsFilterSettings, serverKey, UPSTREAM_ENV } from './settings.js';

function catalog(dnsFilter: Partial<Catalog['dns_filter']> = {}): Catalog {
  return {
    dns_filter: {
      enabled: true, rules_file: 'data/dnsfilter/rules.json', max_rules: 1_000, max_ttl_min: 525_600, block_doh: true,
      blocked_domains: [] as string[], allowed_domains: [] as string[], allowed_clients: [] as string[],
      upstream_timeout_ms: 3_000, max_in_flight: 256, query_log_size: 1_000,
      ...dnsFilter,
    },
  } as unknown as Catalog;
}

const cwd = process.platform === 'win32' ? 'C:\\excubitor' : '/excubitor';

describe('parseEndpoint', () => {
  it('IPv4・角括弧の IPv6・ポート省略 (53) を読む', () => {
    expect(parseEndpoint('127.0.0.1:5353')).toEqual({ ok: true, endpoint: { host: '127.0.0.1', port: 5353, family: 4 } });
    expect(parseEndpoint('[::1]:53')).toEqual({ ok: true, endpoint: { host: '::1', port: 53, family: 6 } });
    expect(parseEndpoint('2606:4700:4700::1111')).toMatchObject({ ok: true, endpoint: { port: 53, family: 6 } });
    expect(parseEndpoint('1.1.1.1')).toMatchObject({ ok: true, endpoint: { port: 53 } });
  });

  it('名前・不正なポート・スコープ付き IPv6 は読まない', () => {
    for (const value of ['dns.google', 'dns.google:53', '1.1.1.1:0', '1.1.1.1:70000', '[fe80::1%12]:53', '']) {
      expect(parseEndpoint(value).ok, value).toBe(false);
    }
  });

  it('一覧は重複を拒否し、 表記を揃える', () => {
    expect(parseEndpointList('127.0.0.1:53, [::1]:53')).toMatchObject({ ok: true });
    expect(parseEndpointList('127.0.0.1, 127.0.0.1:53').ok).toBe(false);
    expect(formatEndpoint({ host: '::1', port: 53, family: 6 })).toBe('[::1]:53');
  });
});

describe('resolveDnsFilterSettings', () => {
  it('env が無ければ規則だけ使え、 待ち受けない', () => {
    const resolved = resolveDnsFilterSettings(catalog(), {}, cwd);
    expect(resolved.rules?.doh.match('mozilla.cloudflare-dns.com')).toBe('cloudflare-dns.com');
    expect(resolved.server).toBeNull();
    expect(resolved.disabledReason).toContain(LISTEN_ENV);
  });

  it('上流が無ければ待ち受けない (推測しない)', () => {
    const resolved = resolveDnsFilterSettings(catalog(), { [LISTEN_ENV]: '127.0.0.1:53' }, cwd);
    expect(resolved.server).toBeNull();
    expect(resolved.disabledReason).toContain(UPSTREAM_ENV);
  });

  it('両方あれば待ち受けの設定を返す', () => {
    const resolved = resolveDnsFilterSettings(catalog({ allowed_clients: ['203.0.113.0/24'] }), {
      [LISTEN_ENV]: '127.0.0.1:53,[::1]:53', [UPSTREAM_ENV]: '1.1.1.1',
    }, cwd);
    expect(resolved.server?.listen.map(formatEndpoint)).toEqual(['127.0.0.1:53', '[::1]:53']);
    expect(resolved.server && formatEndpoint(resolved.server.upstream)).toBe('1.1.1.1:53');
    expect(resolved.server?.clients.allows('203.0.113.9')).toBe(true);
    expect(resolved.server && serverKey(resolved.server)).toContain('203.0.113.0/24');
  });

  it('全アドレスでの待ち受け・自分を上流にする設定・読めない一覧は設定エラー', () => {
    expect(() => resolveDnsFilterSettings(catalog(), { [LISTEN_ENV]: '0.0.0.0:53', [UPSTREAM_ENV]: '1.1.1.1' }, cwd)).toThrow(/使えない/);
    expect(() => resolveDnsFilterSettings(catalog(), { [LISTEN_ENV]: '127.0.0.1:53', [UPSTREAM_ENV]: '127.0.0.1' }, cwd)).toThrow(/自分の待ち受け/);
    expect(() => resolveDnsFilterSettings(catalog(), { [LISTEN_ENV]: 'localhost', [UPSTREAM_ENV]: '1.1.1.1' }, cwd)).toThrow(LISTEN_ENV);
    expect(() => resolveDnsFilterSettings(catalog({ blocked_domains: ['bad domain'] }), {}, cwd)).toThrow(/blocked_domains/);
  });

  it('enabled=false なら規則も止める。 block_doh=false なら DoH を止めない', () => {
    expect(resolveDnsFilterSettings(catalog({ enabled: false }), {}, cwd)).toEqual({ rules: null, server: null, disabledReason: 'dns_filter.enabled=false' });
    expect(resolveDnsFilterSettings(catalog({ block_doh: false }), {}, cwd).rules?.doh.size).toBe(0);
  });
});

describe('ClientPolicy', () => {
  it('既定は loopback・LAN・Tailscale だけ。 IPv4 射影も IPv4 として見る', () => {
    const policy = ClientPolicy.build([]);
    for (const address of ['127.0.0.1', '192.168.1.20', '100.100.1.1', '::1', '::ffff:10.0.0.5', 'fe80::1']) {
      expect(policy.allows(address), address).toBe(true);
    }
    for (const address of ['203.0.113.9', '2001:db8::1', '::ffff:198.51.100.1', 'not-an-address']) {
      expect(policy.allows(address), address).toBe(false);
    }
  });

  it('読めない追加の範囲は設定エラー', () => {
    expect(() => ClientPolicy.build(['lan'])).toThrow(/allowed_clients/);
  });
});
