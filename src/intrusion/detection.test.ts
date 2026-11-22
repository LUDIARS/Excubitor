import { describe, it, expect } from 'vitest';
import { intrusionConfigSchema } from './config.js';
import { IntrusionDetector } from './detection.js';
import { config, event } from './test-fixtures.js';

describe('intrusion policy', () => {
  it('accepts domestic access and rejects foreign, unknown, malformed and Tor metadata', () => {
    const detector = new IntrusionDetector(config);
    expect(detector.inspect(event)).toBeNull();
    expect(detector.inspect({ ...event, country: 'US' })).toBe('foreign_country');
    expect(detector.inspect({ ...event, country: 'T1' })).toBe('foreign_country');
    expect(detector.inspect({ ...event, country: 'XX' })).toBe('unknown_country');
    expect(detector.inspect({ ...event, clientIp: '203.0.113.1, 127.0.0.1' })).toBe('invalid_identity');
  });
  it('detects encoded traversal and sensitive-file probes, not a normal dot in a filename', () => {
    const detector = new IntrusionDetector(config);
    for (const path of ['/a/%252e%252e/etc/passwd', '/.env', '/.git/config', '/a\\..\\private']) {
      expect(detector.inspect({ ...event, path })).toBe('exploit_path');
    }
    expect(detector.inspect({ ...event, path: '/assets/main.js' })).toBeNull();
  });
  it('counts bursts and expires old windows', () => {
    const detector = new IntrusionDetector(config);
    for (let i = 0; i < 9; i++) expect(detector.inspect(event)).toBeNull();
    expect(detector.inspect(event)).toBe('request_burst');
    expect(detector.inspect({ ...event, at: 61_001 })).toBeNull();
    expect(detector.response(event, 401)).toBeNull();
    expect(detector.response(event, 403)).toBe('authentication_burst');
  });
  it('lets non-allowed countries through only on a route foreign-country path, keeping every other check', () => {
    const detector = new IntrusionDetector(config);
    const exempt = { ...event, foreignCountryPaths: ['/v1/instructions'], foreignCountryHeaderPresent: true, path: '/v1/instructions' };
    expect(detector.inspect({ ...exempt, country: 'US' })).toBeNull();
    expect(detector.inspect({ ...exempt, country: 'XX', path: '/v1/instructions/x' })).toBeNull();
    expect(detector.inspect({ ...exempt, country: 'US', path: '/v1/instructionsX' })).toBe('foreign_country');
    expect(detector.inspect({ ...exempt, country: 'US', path: '/other' })).toBe('foreign_country');
    expect(detector.inspect({ ...event, country: 'US', path: '/v1/instructions' })).toBe('foreign_country');
    expect(detector.inspect({ ...exempt, country: 'US', foreignCountryHeaderPresent: false })).toBe('foreign_country');
    expect(detector.inspect({ ...exempt, country: 'XX', foreignCountryHeaderPresent: undefined })).toBe('unknown_country');
    expect(detector.inspect({ ...exempt, country: 'T1' })).toBe('foreign_country');
    expect(detector.inspect({ ...exempt, country: 'US', clientIp: 'bad' })).toBe('invalid_identity');
    expect(detector.inspect({ ...exempt, country: 'US', path: '/v1/instructions/%2e%2e/.env' })).toBe('exploit_path');
    expect(detector.inspect({ ...exempt, country: 'US', path: '/v1/instructions/%E0%A4%A' })).toBe('foreign_country');
    const burst = new IntrusionDetector(config);
    for (let i = 0; i < 9; i++) expect(burst.inspect({ ...exempt, country: 'US' })).toBeNull();
    expect(burst.inspect({ ...exempt, country: 'US' })).toBe('request_burst');
  });
  it('rejects arbitrary upstreams, credentials and incomplete tunnel coverage', () => {
    expect(() => intrusionConfigSchema.parse({ ...config, routes: [{ ...config.routes[0], origin: 'https://external.example' }] })).toThrow();
    expect(() => intrusionConfigSchema.parse({ ...config, tunnels: [] })).toThrow();
  });
});
