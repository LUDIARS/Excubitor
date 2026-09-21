import { describe, expect, it } from 'vitest';
import {
  ALLOW_CIDRS_ENV,
  DEFAULT_ALLOW_CIDRS,
  LISTEN_ENV,
  parseCidr,
  parseFederationListenConfig,
  parseListenEntry,
} from './listen-config.js';

describe('parseFederationListenConfig', () => {
  it('stays off when the listen address is not configured', () => {
    expect(parseFederationListenConfig({}, 17335)).toEqual({ enabled: false, error: null });
    expect(parseFederationListenConfig({ [LISTEN_ENV]: '  ' }, 17335)).toEqual({ enabled: false, error: null });
  });

  it('binds the mesh address on the catalog-declared port with the default allowlist', () => {
    const config = parseFederationListenConfig({ [LISTEN_ENV]: '100.101.102.103' }, 17335);
    expect(config).toMatchObject({
      enabled: true,
      addresses: [{ host: '100.101.102.103', port: 17335 }],
    });
    if (!config.enabled) throw new Error('expected enabled');
    expect(config.allow.map((c) => `${c.network}/${c.prefix}`)).toEqual(DEFAULT_ALLOW_CIDRS);
  });

  it('accepts several addresses and explicit ports', () => {
    const config = parseFederationListenConfig(
      { [LISTEN_ENV]: '100.64.1.2:18000, [fd7a:115c:a1e0::5]:18001' },
      17335,
    );
    expect(config).toMatchObject({
      enabled: true,
      addresses: [{ host: '100.64.1.2', port: 18000 }, { host: 'fd7a:115c:a1e0::5', port: 18001 }],
    });
  });

  it('refuses to bind every interface', () => {
    for (const wildcard of ['0.0.0.0', '::', '[::]:17335', '0.0.0.0:17335']) {
      const config = parseFederationListenConfig({ [LISTEN_ENV]: wildcard }, 17335);
      expect(config.enabled).toBe(false);
      expect(config).toMatchObject({ error: expect.stringContaining('wildcard') });
    }
  });

  it('fails fast when no port is known', () => {
    const config = parseFederationListenConfig({ [LISTEN_ENV]: '100.64.1.2' }, null);
    expect(config).toMatchObject({ enabled: false, error: expect.stringContaining('no port') });
  });

  it('rejects a malformed allowlist instead of falling back to allow-all', () => {
    const config = parseFederationListenConfig(
      { [LISTEN_ENV]: '100.64.1.2', [ALLOW_CIDRS_ENV]: '100.64.0.0/10, not-an-ip' },
      17335,
    );
    expect(config).toMatchObject({ enabled: false, error: expect.stringContaining(ALLOW_CIDRS_ENV) });
  });
});

describe('parseListenEntry', () => {
  it('parses host forms', () => {
    expect(parseListenEntry('kaoimac.example.ts.net:17335', null)).toEqual({ host: 'kaoimac.example.ts.net', port: 17335 });
    expect(parseListenEntry('fd7a:115c:a1e0::1', 17335)).toEqual({ host: 'fd7a:115c:a1e0::1', port: 17335 });
    expect(parseListenEntry('100.64.1.2:99999', null)).toMatch(/invalid port/);
  });
});

describe('parseCidr', () => {
  it('parses networks and single addresses', () => {
    expect(parseCidr('100.64.0.0/10')).toEqual({ network: '100.64.0.0', prefix: 10, family: 'ipv4' });
    expect(parseCidr('::1')).toEqual({ network: '::1', prefix: 128, family: 'ipv6' });
    expect(parseCidr('10.0.0.0/33')).toMatch(/invalid prefix/);
  });
});
