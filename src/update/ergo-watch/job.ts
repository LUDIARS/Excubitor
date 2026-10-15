/**
 * Ergo パッケージ更新の配送ジョブ 1 回分: 対象の収集 → `ergo_pkg watch` → 出来事の整形 → 配送
 * (Concordia 経由、 または webhook 直送)。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog } from '../../catalog/loader.js';
import type { ErgoWatchConfig } from './config.js';
import { newRunId, queueConcordiaBatches, toConcordiaOutbox } from './concordia-batches.js';
import { deliverToConcordia, type PackageUpdatePoster } from './concordia-deliver.js';
import { deliverMessages, type WebhookSender } from './deliver.js';
import { readDeliveryState, writeDeliveryState, type DeliveryState } from './delivery-state.js';
import { collectWatchHosts, type HostIssue } from './hosts.js';
import { planDelivery } from './plan.js';
import { clearEventsFile, readEventsFile, readHostReports } from './reports.js';
import { runErgoWatch } from './runner.js';
import { formatRunText } from './summary-format.js';
import type { DeliveryChannel, DeliveryMessage } from './types.js';
import { buildWatchArgs, resolveWatchEndpoints } from './watch-args.js';

/** 配送先。 `ergo_watch.delivery` で選ぶ (既定 concordia)。 */
export type JobDelivery =
  | { mode: 'concordia'; post?: PackageUpdatePoster; runId?: string }
  | { mode: 'discord'; webhooks: Record<DeliveryChannel, string>; send?: WebhookSender };

export interface JobInput {
  catalog: Catalog;
  config: ErgoWatchConfig;
  stateDir: string;
  now: Date;
  /** null なら配送せず、 本文を返すだけ (状態も書かない)。 */
  delivery: JobDelivery | null;
}

export interface JobDeliverySummary {
  mode: JobDelivery['mode'];
  sent: number;
  /** 非公開用 webhook が未設定で送らなかった数 (discord のみ)。 */
  withheld: number;
  /** 次の回へ持ち越したメッセージの数。 */
  unsent: number;
  /** この回の runId (concordia のみ。 持ち越した束は元の runId のまま)。 */
  runId: string | null;
  error: string | null;
}

export interface JobResult {
  ok: boolean;
  hosts: number;
  events: number;
  issues: HostIssue[];
  error: string | null;
  text: string;
  messages: DeliveryMessage[];
  delivery: JobDeliverySummary | null;
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
  if (!input.delivery) return result;

  const sent = input.delivery.mode === 'concordia'
    ? await sendViaConcordia(input.delivery, state, plan.messages, input.now)
    : await sendViaWebhook(input.delivery, state, plan.messages);
  writeDeliveryState(input.stateDir, {
    ...sent.state,
    schema: 1,
    last_summary_date: plan.summaryDate ?? state.last_summary_date,
    since_summary: plan.summaryDate
      ? { public: 0, private: 0 }
      : {
          public: state.since_summary.public + plan.eventCounts.public,
          private: state.since_summary.private + plan.eventCounts.private,
        },
  });
  return { ...result, ok: sent.summary.error === null, error: sent.summary.error, delivery: sent.summary };
}

interface SendOutcome {
  summary: JobDeliverySummary;
  state: Pick<DeliveryState, 'outbox' | 'concordia_outbox'>;
}

async function sendViaConcordia(
  delivery: Extract<JobDelivery, { mode: 'concordia' }>,
  state: DeliveryState,
  messages: DeliveryMessage[],
  now: Date,
): Promise<SendOutcome> {
  const runId = delivery.runId ?? newRunId(now);
  // 前回送れなかった束を同じ runId で先に送り、 順序を保つ。 送るものが無い回は送らない。
  const result = await deliverToConcordia(queueConcordiaBatches(state, runId, messages), delivery.post);
  return {
    summary: {
      mode: 'concordia',
      sent: result.sent,
      withheld: 0,
      unsent: result.unsent.reduce((total, batch) => total + batch.messages.length, 0),
      runId: messages.length > 0 || state.outbox.length > 0 ? runId : null,
      error: result.error,
    },
    state: { outbox: [], concordia_outbox: toConcordiaOutbox(result.unsent) },
  };
}

async function sendViaWebhook(
  delivery: Extract<JobDelivery, { mode: 'discord' }>,
  state: DeliveryState,
  messages: DeliveryMessage[],
): Promise<SendOutcome> {
  // 前回送れなかったものを先に送り、 順序を保つ。
  const result = await deliverMessages([...state.outbox, ...messages], delivery.webhooks, delivery.send);
  return {
    summary: {
      mode: 'discord',
      sent: result.sent,
      withheld: result.withheld,
      unsent: result.unsent.length,
      runId: null,
      error: result.error,
    },
    state: { outbox: result.unsent, concordia_outbox: state.concordia_outbox },
  };
}
