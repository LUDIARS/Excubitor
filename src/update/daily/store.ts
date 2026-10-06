/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { randomUUID } from 'node:crypto';
import { currentDb } from '../../db/index.js';
import { DailySettingsSchema, type DailyRun, type DailySettings } from './types.js';

export function readDailySettings(): DailySettings {
  const row = currentDb().prepare('SELECT settings FROM daily_update_state WHERE id=1').get() as { settings: string } | undefined;
  return row ? DailySettingsSchema.parse(JSON.parse(row.settings)) : {
    enabled: false, time: '06:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
export function saveDailySettings(input: unknown): DailySettings {
  const settings = DailySettingsSchema.parse(input);
  currentDb().prepare('INSERT INTO daily_update_state(id,settings) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings')
    .run(JSON.stringify(settings));
  return settings;
}
export function dailyRuns(): DailyRun[] {
  const rows = currentDb().prepare('SELECT payload FROM daily_update_runs ORDER BY started_at DESC LIMIT 30').all() as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as DailyRun);
}
export function activeDailyRun(): DailyRun | null {
  const row = currentDb().prepare("SELECT payload FROM daily_update_runs WHERE status='running' LIMIT 1").get() as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as DailyRun : null;
}
export function saveDailyRun(run: DailyRun): void {
  currentDb().prepare('UPDATE daily_update_runs SET status=?,payload=? WHERE id=?').run(run.status, JSON.stringify(run), run.id);
}
/** Atomic with the manual operation running state; the supervisor is the sole daily writer. */
export function beginDailyRun(day: string, now: Date): DailyRun | null {
  return currentDb().transaction(() => {
    if (activeDailyRun()) return null;
    if (currentDb().prepare("SELECT 1 FROM federation_operations WHERE status IN ('running','restarting','queued') LIMIT 1").get()) return null;
    if (currentDb().prepare('SELECT 1 FROM daily_manual_updates LIMIT 1').get()) return null;
    if (currentDb().prepare('SELECT 1 FROM daily_update_runs WHERE day=?').get(day)) return null;
    const run: DailyRun = { id: randomUUID(), day, startedAt: now.toISOString(), finishedAt: null,
      status: 'running', checkpoint: null, events: [], notification: null };
    currentDb().prepare('INSERT INTO daily_update_runs(id,day,started_at,status,payload) VALUES(?,?,?,?,?)')
      .run(run.id, day, run.startedAt, run.status, JSON.stringify(run));
    return run;
  }).immediate();
}
export function beginManualUpdate(id: string): boolean {
  return currentDb().transaction(() => {
    if (activeDailyRun()) return false;
    currentDb().prepare('INSERT INTO daily_manual_updates(id) VALUES(?)').run(id);
    return true;
  }).immediate();
}
export function endManualUpdate(id: string): void {
  currentDb().prepare('DELETE FROM daily_manual_updates WHERE id=?').run(id);
}
export function clearInterruptedManualUpdates(): void {
  // Called only during supervisor boot, before exposing lifecycle requests.
  currentDb().prepare('DELETE FROM daily_manual_updates').run();
}
export function retryDailyRecovery(id: string): boolean {
  return currentDb().transaction(() => {
    if (activeDailyRun() || currentDb().prepare('SELECT 1 FROM daily_manual_updates LIMIT 1').get()) return false;
    if (currentDb().prepare("SELECT 1 FROM federation_operations WHERE status IN ('running','restarting','queued') LIMIT 1").get()) return false;
    const row = currentDb().prepare("SELECT payload FROM daily_update_runs WHERE id=? AND status='failed'").get(id) as { payload: string } | undefined;
    if (!row) return false;
    const run = JSON.parse(row.payload) as DailyRun;
    if (!run.checkpoint) return false;
    run.status = 'running'; run.finishedAt = null;
    saveDailyRun(run);
    return true;
  }).immediate();
}
