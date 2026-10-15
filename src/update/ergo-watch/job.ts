/**
 * Ergo パッケージ更新の配送ジョブ 1 回分: 対象の収集 → `ergo_pkg watch` → 出来事の整形 → 配送。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog } from '../../catalog/loader.js';
import type { ErgoWatchConfig } from './config.js';
import { deliverMessages, type DeliveryResult, type WebhookSender } from './deliver.js';
import { readDeliveryState, writeDeliveryState } from './delivery-state.js';
import { collectWatchHosts, type HostIssue } from './hosts.js';
import { planDelivery } from './plan.js';
import { clearEventsFile, readEventsFile, readHostReports } from './reports.js';
import { runErgoWatch } from './runner.js';
import { formatRunText } from './summary-format.js';
import type { DeliveryChannel, DeliveryMessage } from './types.js';
import { buildWatchArgs, resolveWatchEndpoints } from './watch-args.js';

export interface JobInput {
  catalog: Catalog;
  config: ErgoWatchConfig;
  stateDir: string;
  now: Date;
  /** null なら配送せず、 本文を返すだけ (状態も書かない)。 */
  webhooks: Record<DeliveryChannel, string> | null;
  send?: WebhookSender;
}

export interface JobResult {
  ok: boolean;
  hosts: number;
  events: number;
  issues: HostIssue[];
  error: string | null;
  text: string;
  messages: DeliveryMessage[];
  delivery: DeliveryResult | null;
}

export async function runErgoWatchJob(input: JobInput): Promise<JobResult> {
  const { hosts, issues } = collectWatchHosts(input.catalog);
  const base: JobResult = {
    ok: true, hosts: hosts.length, events: 0, issues, error: null, text: '', messages: [], delivery: null,
  };
  if (hosts.length === 0) return { ...base, text: 'ergo_watch の対象がありません。' };

  const outDir = join(input.stateDir, 'out');
  mkdirSync(outDir, { recursive: true });
  clearEventsFile(outDir);
  const args = buildWatchArgs({
    hosts,
    stateDir: input.stateDir,
    outDir,
    endpoints: resolveWatchEndpoints(input.catalog, {
      revisor: input.config.revisor_service,
      concordia: input.config.concordia_service,
    }),
  });
  const run = await runErgoWatch(input.config.ergo_pkg, args, input.stateDir, input.config.timeout_ms);
  if (!run.ok) {
    return { ...base, ok: false, error: `ergo_pkg watch failed (exit ${String(run.exitCode)}): ${run.diagnostic}` };
  }

  const eventsFile = readEventsFile(outDir);
  const hostReports = readHostReports(hosts);
  const state = readDeliveryState(input.stateDir);
  const plan = planDelivery({
    events: eventsFile.events,
    hostReports,
    sources: eventsFile.sources,
    state,
    now: input.now,
    summaryHour: input.config.summary_hour,
  });
  const result: JobResult = {
    ...base,
    events: eventsFile.events.length,
    text: formatRunText(eventsFile.events.length, plan.messages.map((entry) => entry.content)),
    messages: plan.messages,
  };
  if (!input.webhooks) return result;

  // 前回送れなかったものを先に送り、 順序を保つ。
  const delivery = await deliverMessages([...state.outbox, ...plan.messages], input.webhooks, input.send);
  writeDeliveryState(input.stateDir, {
    schema: 1,
    last_summary_date: plan.summaryDate ?? state.last_summary_date,
    since_summary: plan.summaryDate
      ? { public: 0, private: 0 }
      : {
          public: state.since_summary.public + plan.eventCounts.public,
          private: state.since_summary.private + plan.eventCounts.private,
        },
    outbox: delivery.unsent,
  });
  return { ...result, ok: delivery.error === null, error: delivery.error, delivery };
}
