import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOW_CIDRS, parseCidr, type AllowedCidr } from './listen-config.js';
import { createSourceGuard, normalizeAddress } from './source-guard.js';

const defaults = DEFAULT_ALLOW_CIDRS.map((entry) => parseCidr(entry) as AllowedCidr);

describe('createSourceGuard', () => {
  const guard = createSourceGuard(defaults);

  it('lets Tailscale and Cloudflare Mesh addresses in', () => {
    expect(guard.isAllowed('100.101.102.103')).toBe(true); // Tailscale
    expect(guard.isAllowed('100.96.0.7')).toBe(true); // Cloudflare Mesh (WARP)
    expect(guard.isAllowed('fd7a:115c:a1e0::1234')).toBe(true); // Tailscale IPv6
    expect(guard.isAllowed('127.0.0.1')).toBe(true);
  });

  it('keeps LAN and public addresses out', () => {
    expect(guard.isAllowed('192.168.0.3')).toBe(false);
    expect(guard.isAllowed('8.8.8.8')).toBe(false);
    expect(guard.isAllowed('100.128.0.1')).toBe(false); // CGNAT 帯の外
    expect(guard.isAllowed('2001:db8::1')).toBe(false);
  });

  it('understands IPv4-mapped IPv6 from dual-stack sockets', () => {
    expect(guard.isAllowed('::ffff:100.101.102.103')).toBe(true);
    expect(guard.isAllowed('::ffff:192.168.0.3')).toBe(false);
  });

  it('refuses unknown or empty sources', () => {
    expect(guard.isAllowed(undefined)).toBe(false);
    expect(guard.isAllowed('')).toBe(false);
    expect(guard.isAllowed('not-an-ip')).toBe(false);
  });
});

describe('normalizeAddress', () => {
  it('strips the IPv4-mapped prefix and zone ids', () => {
    expect(normalizeAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeAddress(null)).toBeNull();
  });
});
