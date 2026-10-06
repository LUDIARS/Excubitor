/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import type { DailySettings } from './types.js';

/** A date key rather than elapsed 24 hours prevents duplicate runs across DST/restarts. */
export function dueDailyDate(settings: DailySettings, now: Date): string | null {
  if (!settings.enabled) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // A one-hour morning window permits a short restart without an afternoon catch-up.
  const minute = Number(values.hour) * 60 + Number(values.minute);
  const [hour, min] = settings.time.split(':').map(Number);
  const scheduled = (hour ?? 0) * 60 + (min ?? 0);
  return minute >= scheduled && minute < scheduled + 60
    ? `${values.year}-${values.month}-${values.day}` : null;
}
