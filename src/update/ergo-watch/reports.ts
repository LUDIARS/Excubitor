/**
 * `ergo_pkg watch` の出力 (`<out>/events.json` と `<host>/.ergo/watch-report.json`) を読む。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { HostReport } from './routing.js';
import { EventsFileSchema, WatchReportSchema, type EventsFile, type WatchHost } from './types.js';

export const EVENTS_FILE = 'events.json';
export const WATCH_REPORT_PATH = join('.ergo', 'watch-report.json');

/** 前回の events.json を消す (watch が失敗した回に古い出来事を配送しないため)。 */
export function clearEventsFile(outDir: string): void {
  rmSync(join(outDir, EVENTS_FILE), { force: true });
}

export function readEventsFile(outDir: string): EventsFile {
  const raw = readFileSync(join(outDir, EVENTS_FILE), 'utf8');
  return EventsFileSchema.parse(JSON.parse(raw));
}

/** ホストごとの報告。 無い・壊れているホストは report: null (そのホストの出来事は非公開に倒れる)。 */
export function readHostReports(hosts: WatchHost[]): HostReport[] {
  return hosts.map((host) => ({ host, report: readHostReport(host.dir) }));
}

function readHostReport(dir: string): HostReport['report'] {
  const path = join(dir, WATCH_REPORT_PATH);
  if (!existsSync(path)) return null;
  try {
    const parsed = WatchReportSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
