const DAY_MS = 86400000;
const JST_MS = 9 * 3600000;
export function jstDay(at: number): string { return new Date(at + JST_MS).toISOString().slice(0, 10); }
export function reportDay(at: number, hour: number): string | null {
  const jst = new Date(at + JST_MS);
  return jst.getUTCHours() >= hour ? jstDay(at - DAY_MS) : null;
}
