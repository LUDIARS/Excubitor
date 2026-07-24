import { describe, expect, it } from 'vitest';
import { HEALTH_SCAN_INTERVAL_MS } from './loop.js';

describe('health scan interval', () => {
  it('runs the full service health scan every five minutes by default', () => {
    expect(HEALTH_SCAN_INTERVAL_MS).toBe(5 * 60 * 1_000);
  });
});
