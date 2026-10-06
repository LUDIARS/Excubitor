import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, currentDb, openDb } from '../../db/index.js';
import { activeDailyRun, beginDailyRun, beginManualUpdate, endManualUpdate, readDailySettings, saveDailyRun } from './store.js';

describe('daily update exclusion and durable scheduling', () => {
  beforeEach(() => { openDb(':memory:'); });
  afterEach(() => { closeDb(); });
  it('defaults to disabled without silently enabling a site', () => { expect(readDailySettings().enabled).toBe(false); });
  it('excludes manual changes in both directions and remembers a completed date', () => {
    expect(beginManualUpdate('manual')).toBe(true);
    expect(beginDailyRun('2026-10-06', new Date())).toBeNull();
    endManualUpdate('manual');
    const run = beginDailyRun('2026-10-06', new Date());
    expect(run).not.toBeNull();
    expect(beginManualUpdate('other')).toBe(false);
    expect(beginDailyRun('2026-10-07', new Date())).toBeNull();
    if (!run) throw new Error('run missing');
    run.status = 'succeeded'; saveDailyRun(run);
    expect(activeDailyRun()).toBeNull();
    expect(beginDailyRun('2026-10-06', new Date())).toBeNull();
    expect(beginDailyRun('2026-10-07', new Date())).not.toBeNull();
  });
  it('does not race queued or restarting federation operations', () => {
    currentDb().prepare(`INSERT INTO federation_operations(id,requested_by,target_kind,action,source,status,created_at)
      VALUES('op','local','excubitor','deploy','origin','restarting',0)`).run();
    expect(beginDailyRun('2026-10-06', new Date())).toBeNull();
  });
});
