import type { DefenseStore } from './store.js';
import { dailyMessage } from './report.js';

/** Durable claim precedes network I/O: uncertain delivery cannot trigger duplicate retries. */
export async function deliverDaily(store: DefenseStore, day: string, site: string, at: number,
  send: (message: string) => Promise<void>): Promise<'sent' | 'already_attempted' | 'unknown'> {
  const data = store.data(day);
  const message = dailyMessage(site, data);
  if (!store.claimReport(day, JSON.stringify({ ...data, message, generatedAt: at }))) return 'already_attempted';
  try { await send(message); store.delivered(day); return 'sent'; }
  catch { return 'unknown'; } // An HTTP timeout may still have delivered; never blindly retry.
}
