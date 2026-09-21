import { describe, expect, it } from 'vitest';
import { mapWithLimit } from './map-limit.js';

describe('mapWithLimit', () => {
  it('never runs more than the limit at once and keeps input order', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithLimit([5, 1, 4, 2, 3], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it('handles an empty input', async () => {
    await expect(mapWithLimit([], 4, async () => 1)).resolves.toEqual([]);
  });

  it('rejects a non-positive limit instead of silently running everything', async () => {
    await expect(mapWithLimit([1], 0, async () => 1)).rejects.toThrow(/positive integer/);
  });

  it('propagates the first failure', async () => {
    await expect(mapWithLimit([1, 2], 2, async (value) => {
      if (value === 2) throw new Error('boom');
      return value;
    })).rejects.toThrow('boom');
  });
});
