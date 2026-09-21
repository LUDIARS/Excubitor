import { describe, expect, it } from 'vitest';
import { createNonceCache } from './nonce-cache.js';

describe('nonce cache', () => {
  it('accepts a nonce once and rejects it while it is remembered', () => {
    const cache = createNonceCache(1_000);
    expect(cache.remember('a', 0)).toBe(true);
    expect(cache.remember('a', 500)).toBe(false);
    expect(cache.remember('b', 500)).toBe(true);
  });

  it('forgets nonces after the retention window', () => {
    const cache = createNonceCache(1_000);
    cache.remember('a', 0);
    expect(cache.remember('a', 1_000)).toBe(true);
  });

  it('prunes expired entries so memory does not grow without bound', () => {
    const cache = createNonceCache(1_000);
    for (let i = 0; i < 50; i += 1) cache.remember(`n${i}`, 0);
    cache.remember('late', 5_000);
    expect(cache.size()).toBe(1);
  });
});
