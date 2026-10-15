import { readFileSync } from 'node:fs';

import { EventsFileSchema, type EventsFile, type WatchEvent, type WatchReport } from './types.js';

/** 出来事の見本 (秘匿をわざと入れてある: URL・資格情報・パス・PR のタイトルとブランチ名)。 */
export function sampleEvents(): EventsFile {
  const raw = readFileSync(new URL('./fixtures/events-sample.json', import.meta.url), 'utf8');
  return EventsFileSchema.parse(JSON.parse(raw));
}

export function sampleEvent(kind: WatchEvent['kind']): WatchEvent {
  const event = sampleEvents().events.find((entry) => entry.kind === kind);
  if (!event) throw new Error(`no sample event of kind ${kind}`);
  return event;
}

export function sampleReport(host: string, pending: WatchReport['pending'] = []): WatchReport {
  return {
    schema: 1,
    host,
    generated_at: '2026-10-15T00:00:00Z',
    pending,
    sources: { concordia: 'ok', revisor: 'ok' },
  };
}
