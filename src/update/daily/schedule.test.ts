import { describe, expect, it } from 'vitest';
import { dueDailyDate } from './schedule.js';
import { DailySettingsSchema } from './types.js';

describe('daily site schedule', () => {
  const settings = { enabled: true, time: '06:00', timezone: 'Asia/Tokyo' };
  it('does nothing when disabled and never catches up outside the morning window', () => {
    expect(dueDailyDate({ ...settings, enabled: false }, new Date('2026-10-05T21:00:00Z'))).toBeNull();
    expect(dueDailyDate(settings, new Date('2026-10-05T20:59:00Z'))).toBeNull();
    expect(dueDailyDate(settings, new Date('2026-10-05T22:00:00Z'))).toBeNull();
    expect(dueDailyDate(settings, new Date('2026-10-05T21:10:00Z'))).toBe('2026-10-06');
  });
  it('uses the same durable date for both occurrences of a repeated DST hour', () => {
    const dst = { enabled: true, time: '01:00', timezone: 'America/New_York' };
    expect(dueDailyDate(dst, new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
    expect(dueDailyDate(dst, new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01');
  });
  it('rejects invalid timezone/time and unknown settings rather than silently defaulting', () => {
    expect(DailySettingsSchema.safeParse({ ...settings, timezone: 'Not/AZone' }).success).toBe(false);
    expect(DailySettingsSchema.safeParse({ ...settings, time: '24:00' }).success).toBe(false);
    expect(DailySettingsSchema.safeParse({ ...settings, extra: true }).success).toBe(false);
  });
});
