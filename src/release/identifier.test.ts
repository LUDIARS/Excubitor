import { describe, expect, it } from 'vitest';
import { isReleaseIdentifier } from './identifier.js';

export const invalidIdentifiers = ["1'", '1;echo', '1 2', '..', '../x', '1/x', '1\\x', '', 'a'.repeat(65), '1\n'];
export const validIdentifiers = ['0.0.0', '1.2.3', '1.2.3-rc.1+build', 'a'.repeat(64)];

describe('release identifier', () => {
  it.each(invalidIdentifiers)('rejects %j', (value) => expect(isReleaseIdentifier(value)).toBe(false));
  it.each(validIdentifiers)('accepts %j', (value) => expect(isReleaseIdentifier(value)).toBe(true));
  it.each([null, undefined, 123, {}])('rejects non-string %j', (value) => expect(isReleaseIdentifier(value)).toBe(false));
});
