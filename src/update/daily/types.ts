/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { z } from 'zod';
import type { Service } from '../../catalog/loader.js';

export const DailySettingsSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Invalid IANA timezone'),
}).strict();
export type DailySettings = z.infer<typeof DailySettingsSchema>;
export interface RepositoryCheckpoint {
  path: string;
  branch: string;
  before: string;
  after: string;
  services: Service[];
  running: string[];
  phase: 'prepared' | 'stopping' | 'updating' | 'building' | 'starting' | 'rollback';
}
export interface DailyEvent { repository: string; status: string; detail: string }
export interface DailyRun {
  id: string;
  day: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  checkpoint: RepositoryCheckpoint | null;
  events: DailyEvent[];
  notification: string | null;
}
