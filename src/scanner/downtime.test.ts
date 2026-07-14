import { describe, expect, it } from 'vitest';
import { computeDowntimeSummary } from './downtime.js';

describe('computeDowntimeSummary', () => {
  it('sums failed intervals and counts incidents inside the window', () => {
    const summary = computeDowntimeSummary(
      [
        { t: 1_000, ok: true },
        { t: 2_000, ok: false },
        { t: 5_000, ok: false },
        { t: 7_000, ok: true },
        { t: 9_000, ok: false },
      ],
      { since: 1_000, now: 11_000, windowMs: 10_000 },
    );

    expect(summary.downtime_ms).toBe(7_000);
    expect(summary.incidents).toBe(2);
    expect(summary.current_down_since).toBe(9_000);
    expect(summary.current_down_ms).toBe(2_000);
    expect(summary.uptime_ratio).toBeCloseTo(0.3);
  });

  it('carries a down state from before the window without counting a new incident', () => {
    const summary = computeDowntimeSummary(
      [
        { t: 500, ok: false },
        { t: 4_000, ok: false },
        { t: 8_000, ok: true },
      ],
      { since: 1_000, now: 11_000, windowMs: 10_000 },
    );

    expect(summary.downtime_ms).toBe(7_000);
    expect(summary.incidents).toBe(0);
    expect(summary.current_down_since).toBeNull();
    expect(summary.current_down_ms).toBe(0);
    expect(summary.last_down_at).toBe(4_000);
    expect(summary.last_ok_at).toBe(8_000);
  });

  it('returns a full-window downtime when the service stayed down', () => {
    const summary = computeDowntimeSummary(
      [{ t: 500, ok: false }],
      { since: 1_000, now: 11_000, windowMs: 10_000 },
    );

    expect(summary.downtime_ms).toBe(10_000);
    expect(summary.uptime_ratio).toBe(0);
    expect(summary.current_down_since).toBe(500);
    expect(summary.current_down_ms).toBe(10_500);
  });
});
