import { describe, it, expect, vi } from 'vitest';
import { UserAccessLog } from './user-access-log.js';
import { userAccessMetadata } from './user-access-metadata.js';

const event = { at: Date.UTC(2026, 9, 28), service: 'one', hostname: 'one.example.com',
  country: 'JP', clientIp: '192.0.2.1', method: 'GET', path: '/' };
const meta = { cf_ray: '0123456789abcdef-NRT', user_agent: 'Phone', accept_language: 'ja' };

describe('user access visits', () => {
  it('deduplicates only within a service, ignores changing Rays, and extends idle expiry', () => {
    const write = vi.fn(); const log = new UserAccessLog(write, vi.fn());
    log.record(event, meta);
    log.record({ ...event, at: event.at + 29 * 60_000 }, { ...meta, cf_ray: 'fedcba9876543210-NRT' });
    log.record({ ...event, at: event.at + 31 * 60_000 }, meta);
    expect(write).toHaveBeenCalledTimes(1);
    log.record({ ...event, service: 'two' }, meta);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].service).toBe('excubitor-user-access-two');
    log.record({ ...event, at: event.at + 61 * 60_000 }, meta);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('separates changed browser, address, language, day and process lifetime', () => {
    const write = vi.fn(); const log = new UserAccessLog(write, vi.fn());
    log.record(event, meta);
    log.record(event, { ...meta, user_agent: 'Desktop' });
    log.record(event, { ...meta, accept_language: 'en' });
    log.record({ ...event, clientIp: '192.0.2.2' }, meta);
    log.record({ ...event, at: event.at + 86400_000 }, meta);
    new UserAccessLog(write, vi.fn()).record(event, meta);
    expect(write).toHaveBeenCalledTimes(6);
    const text = JSON.stringify(write.mock.calls);
    expect(text).not.toContain(event.clientIp);
    expect(write.mock.calls[0]![0].ctx.cf_ray).toBe(meta.cf_ray);
  });

  it('retries unsuccessful writes and surfaces degradation without throwing', () => {
    const write = vi.fn().mockImplementationOnce(() => { throw new Error('disk'); });
    const warn = vi.fn(); const log = new UserAccessLog(write, warn);
    expect(() => log.record(event, meta)).not.toThrow();
    expect(log.status()).toBe('failed');
    log.record(event, meta);
    expect(write).toHaveBeenCalledTimes(2);
    expect(log.status()).toBe('healthy');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('bounds visitor storage by evicting least recently seen entries', () => {
    const write = vi.fn(); const log = new UserAccessLog(write, vi.fn());
    for (let i = 0; i <= 10000; i++) log.record(event, { ...meta, user_agent: String(i) });
    log.record(event, { ...meta, user_agent: '10000' });
    expect(write).toHaveBeenCalledTimes(10001);
    log.record(event, { ...meta, user_agent: '0' });
    expect(write).toHaveBeenCalledTimes(10002);
  });

  it('selects bounded public metadata only and rejects malformed Ray IDs', () => {
    const metadata = userAccessMetadata({ 'cf-ray': 'invalid', 'user-agent': 'A\r\n' + 'B'.repeat(2000),
      cookie: 'private', authorization: 'secret',
      'cf-access-jwt-assertion': 'token' });
    expect(metadata.cf_ray).toBeNull();
    expect(metadata.user_agent).toHaveLength(1024);
    expect(metadata.user_agent).not.toMatch(/[\r\n]/);
    expect(metadata.accept_language).toBe('');
    expect(Object.keys(metadata)).toEqual(['cf_ray', 'user_agent', 'accept_language']);
  });
});
