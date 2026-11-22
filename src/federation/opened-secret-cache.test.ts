import { describe, expect, it, vi } from 'vitest';
import { createOpenedSecretCache } from './opened-secret-cache.js';

describe('createOpenedSecretCache (SPEC-EX-PEER-SECRET-CACHE)', () => {
  it('opens each stored value once and serves repeats from memory', () => {
    const opener = vi.fn((stored: string) => `plain:${stored}`);
    const cache = createOpenedSecretCache(opener);
    expect(cache.open('blob-a')).toBe('plain:blob-a');
    expect(cache.open('blob-a')).toBe('plain:blob-a');
    expect(cache.open('blob-b')).toBe('plain:blob-b');
    expect(opener).toHaveBeenCalledTimes(2);
  });

  it('opens a changed stored value again, so rotated secrets take effect immediately', () => {
    const opener = vi.fn((stored: string) => `plain:${stored}`);
    const cache = createOpenedSecretCache(opener);
    cache.open('blob-old');
    expect(cache.open('blob-new')).toBe('plain:blob-new');
    expect(opener).toHaveBeenCalledWith('blob-new');
  });

  it('remembers an unopenable value as null without retrying the key derivation', () => {
    const opener = vi.fn(() => null);
    const cache = createOpenedSecretCache(opener);
    expect(cache.open('bad-blob')).toBeNull();
    expect(cache.open('bad-blob')).toBeNull();
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('returns null for a missing column without calling the opener', () => {
    const opener = vi.fn((stored: string) => stored);
    const cache = createOpenedSecretCache(opener);
    expect(cache.open(null)).toBeNull();
    expect(opener).not.toHaveBeenCalled();
  });

  it('drops the oldest entries beyond the limit', () => {
    const opener = vi.fn((stored: string) => stored);
    const cache = createOpenedSecretCache(opener, 2);
    for (const value of ['a', 'b', 'c']) cache.open(value);
    expect(cache.size).toBe(2);
    cache.open('a');
    expect(opener).toHaveBeenCalledTimes(4);
  });
});
