import { describe, expect, it } from 'vitest';
import { intrusionConfigSchema } from './config.js';
import { decodeRequestPath, hasRequiredHeader, isForeignCountryExempt } from './foreign-country-exemption.js';
import { config } from './test-fixtures.js';

const withRoute = (extra: Record<string, unknown>) => ({ ...config, routes: [{ ...config.routes[0]!, ...extra }] });
const withPaths = (foreignCountryPaths: unknown) => withRoute({ foreignCountryPaths, foreignCountryRequiredHeaders: ['x-excubitor-token'] });

describe('route foreign-country path exemption', () => {
  it('matches only on a segment boundary', () => {
    const prefixes = ['/v1/instructions'];
    expect(isForeignCountryExempt(prefixes, '/v1/instructions')).toBe(true);
    expect(isForeignCountryExempt(prefixes, '/v1/instructions/abc')).toBe(true);
    expect(isForeignCountryExempt(prefixes, '/v1/instructionsX')).toBe(false);
    expect(isForeignCountryExempt(prefixes, '/v1')).toBe(false);
    expect(isForeignCountryExempt(undefined, '/v1/instructions')).toBe(false);
  });
  it('decodes like the exploit-path check and reports malformed escapes', () => {
    expect(decodeRequestPath('/v1/%2569nstructions')).toBe('/v1/instructions');
    expect(decodeRequestPath('/%E0%A4%A')).toBeNull();
  });
  it('accepts literal prefixes and rejects site-wide, wildcard, dot and malformed entries', () => {
    expect(intrusionConfigSchema.parse(withPaths(['/v1/instructions'])).routes[0]!.foreignCountryPaths).toEqual(['/v1/instructions']);
    for (const bad of [[], ['/'], ['v1'], ['/v1/*'], ['/v1/../admin'], ['/v1/./x'], ['/v1/'], ['/v1//x'],
      ['/v1?x=1'], ['/v1%2f'], ['/' + 'a'.repeat(256)], Array.from({ length: 17 }, (_v, i) => `/p${i}`)]) {
      expect(() => intrusionConfigSchema.parse(withPaths(bad))).toThrow();
    }
  });
  it('requires a credential header alongside the paths and rejects headers every client sends', () => {
    const paths = ['/v1/instructions'];
    expect(intrusionConfigSchema.parse(withRoute({ foreignCountryPaths: paths,
      foreignCountryRequiredHeaders: ['x-excubitor-token', 'authorization'] })).routes[0]!.foreignCountryRequiredHeaders)
      .toEqual(['x-excubitor-token', 'authorization']);
    expect(() => intrusionConfigSchema.parse(withRoute({ foreignCountryPaths: paths }))).toThrow();
    expect(() => intrusionConfigSchema.parse(withRoute({ foreignCountryRequiredHeaders: ['authorization'] }))).toThrow();
    for (const bad of [[], ['Authorization'], ['x token'], ['host'], ['cf-ipcountry'], ['x-forwarded-for'], ['user-agent'],
      ['cookie'], ['a', 'b', 'c', 'd', 'e'], ['x'.repeat(65)]]) {
      expect(() => intrusionConfigSchema.parse(withRoute({ foreignCountryPaths: paths, foreignCountryRequiredHeaders: bad }))).toThrow();
    }
  });
  it('checks header presence only, treating blank values as absent', () => {
    const names = ['x-excubitor-token', 'authorization'];
    expect(hasRequiredHeader(names, { authorization: 'Bearer x' })).toBe(true);
    expect(hasRequiredHeader(names, { 'x-excubitor-token': ['', 'k'] })).toBe(true);
    expect(hasRequiredHeader(names, {})).toBe(false);
    expect(hasRequiredHeader(names, { authorization: '', 'x-excubitor-token': '  ' })).toBe(false);
    expect(hasRequiredHeader(names, { cookie: 'a=b' })).toBe(false);
    expect(hasRequiredHeader(undefined, { authorization: 'Bearer x' })).toBe(false);
  });
});
