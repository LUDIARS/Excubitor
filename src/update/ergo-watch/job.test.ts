import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Catalog } from '../../catalog/loader.js';
import type { PackageUpdateBatch } from './concordia-batches.js';
import type { PackageUpdatePoster, PostOutcome } from './concordia-deliver.js';
import { readDeliveryState } from './delivery-state.js';
import { runErgoWatchJob, type JobDelivery } from './job.js';
import { WATCH_REPORT_PATH } from './reports.js';
import { sampleReport } from './test-fixtures.js';

const runner = vi.hoisted(() => ({ withEvents: true, hostDir: '' }));

vi.mock('./hosts.js', () => ({
  collectWatchHosts: () => ({ hosts: [{ dir: runner.hostDir, serviceCodes: ['ln'], private: false }], issues: [] }),
}));
vi.mock('./watch-args.js', () => ({
  buildWatchArgs: () => ['watch'],
  resolveWatchEndpoints: () => ({ revisorUrl: null, concordiaUrl: null }),
}));
vi.mock('./runner.js', () => ({
  runErgoWatch: async (_pkg: string, _args: string[], stateDir: string) => {
    const out = join(stateDir, 'out', 'events.json');
    if (runner.withEvents) copyFileSync(fileURLToPath(new URL('./fixtures/events-sample.json', import.meta.url)), out);
    else writeFileSync(out, JSON.stringify({ schema: 1, generated_at: '2026-10-15T00:00:00Z', events: [] }));
    return { ok: true, exitCode: 0, diagnostic: '' };
  },
}));

const config = {
  ergo_pkg: 'ergo_pkg',
  delivery: 'concordia' as const,
  revisor_service: 'revisor',
  concordia_service: 'concordia',
  summary_hour: 23,
  timeout_ms: 1_000,
};
const night = new Date(2026, 9, 15, 3, 0, 0);
let stateDir: string;

function recordingPoster(outcomes: PostOutcome[]): { post: PackageUpdatePoster; seen: PackageUpdateBatch[] } {
  const seen: PackageUpdateBatch[] = [];
  return {
    seen,
    post: async (batch) => {
      seen.push(batch);
      return outcomes.shift() ?? { kind: 'accepted', delivered: batch.messages.length, failed: 0, duplicate: false };
    },
  };
}

const run = (delivery: JobDelivery | null) => runErgoWatchJob({
  catalog: {} as Catalog, config, stateDir, now: night, delivery,
});

describe('runErgoWatchJob delivery', () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'ergo-watch-job-'));
    runner.withEvents = true;
    // 公開ホスト Ln の checkout (watch-report.json のホストコードで公開と対応付く)。
    runner.hostDir = join(stateDir, 'ln');
    mkdirSync(join(runner.hostDir, '.ergo'), { recursive: true });
    writeFileSync(join(runner.hostDir, WATCH_REPORT_PATH), JSON.stringify(sampleReport('Ln')));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it('sends the formatted events to Concordia, private ones included', async () => {
    const { post, seen } = recordingPoster([]);
    const result = await run({ mode: 'concordia', post, runId: 'run-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe('run-1');
    expect(seen[0]!.messages.map((message) => message.text)).toEqual(result.messages.map((message) => message.content));
    expect(seen[0]!.messages.some((message) => message.private)).toBe(true);
    expect(result.delivery).toMatchObject({ mode: 'concordia', sent: result.messages.length, unsent: 0, runId: 'run-1' });
    expect(readDeliveryState(stateDir).concordia_outbox).toEqual([]);
  });

  it('uses the webhook only when delivery is discord', async () => {
    const send = vi.fn(async (_url: string, _content: string) => undefined);
    const result = await run({ mode: 'discord', webhooks: { public: 'pub', private: '' }, send });
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls.every(([url]) => url === 'pub')).toBe(true);
    expect(result.delivery).toMatchObject({ mode: 'discord', withheld: 1, runId: null });
  });

  it('resends a failed batch on the next run with the same runId', async () => {
    const first = recordingPoster([{ kind: 'retry', error: 'concordia unreachable: offline' }]);
    const failed = await run({ mode: 'concordia', post: first.post, runId: 'run-a' });
    expect(failed.ok).toBe(false);
    expect(readDeliveryState(stateDir).concordia_outbox.map((entry) => entry.run_id)).toEqual(['run-a']);

    runner.withEvents = false;
    const second = recordingPoster([]);
    const retried = await run({ mode: 'concordia', post: second.post, runId: 'run-b' });
    expect(second.seen.map((batch) => batch.runId)).toEqual(['run-a']);
    expect(second.seen[0]!.messages).toEqual(first.seen[0]!.messages);
    expect(retried.ok).toBe(true);
    expect(readDeliveryState(stateDir).concordia_outbox).toEqual([]);
  });

  it('does not post on a run without events', async () => {
    runner.withEvents = false;
    const { post, seen } = recordingPoster([]);
    const result = await run({ mode: 'concordia', post, runId: 'idle' });
    expect(seen).toEqual([]);
    expect(result.delivery).toMatchObject({ sent: 0, runId: null });
  });
});
