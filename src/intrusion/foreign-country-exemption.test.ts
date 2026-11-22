import { describe, expect, it } from 'vitest';
import { intrusionConfigSchema } from './config.js';
import { decodeRequestPath, isForeignCountryExempt } from './foreign-country-exemption.js';
import { config } from './test-fixtures.js';

const withPaths = (foreignCountryPaths: unknown) => ({ ...config, routes: [{ ...config.routes[0]!, foreignCountryPaths }] });

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
});
