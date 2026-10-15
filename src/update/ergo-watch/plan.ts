/**
 * 1 回分の配送内容を決める (純粋関数): 出来事ごとのメッセージ + 必要なら日次要約。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { localDate, isSummaryDue, type DeliveryState } from './delivery-state.js';
import { formatEventMessage } from './event-format.js';
import { hostPrivacyByCode, routeEvents, type HostReport } from './routing.js';
import { formatDailySummary } from './summary-format.js';
import type { DeliveryChannel, DeliveryMessage, WatchEvent, WatchSources } from './types.js';

export interface PlanInput {
  events: WatchEvent[];
  hostReports: HostReport[];
  sources: WatchSources | null;
  state: DeliveryState;
  now: Date;
  summaryHour: number;
}

export interface DeliveryPlan {
  messages: DeliveryMessage[];
  /** この回に配送先ごとに出す出来事の数。 */
  eventCounts: Record<DeliveryChannel, number>;
  /** 日次要約を含めたか (含めたらその日付を状態へ書く)。 */
  summaryDate: string | null;
}

export function planDelivery(input: PlanInput): DeliveryPlan {
  const privacy = hostPrivacyByCode(input.hostReports);
  const routed = routeEvents(input.events, privacy);
  const messages: DeliveryMessage[] = [];
  for (const channel of ['public', 'private'] as const) {
    for (const event of routed[channel]) {
      for (const content of formatEventMessage(event)) messages.push({ channel, content });
    }
  }
  const eventCounts = { public: routed.public.length, private: routed.private.length };

  if (!isSummaryDue(input.state, input.now, input.summaryHour)) {
    return { messages, eventCounts, summaryDate: null };
  }
  const date = localDate(input.now);
  for (const channel of ['public', 'private'] as const) {
    const reports = input.hostReports
      .filter(({ report }) => report !== null)
      .filter(({ report }) => (privacy.get(report!.host) ? 'private' : 'public') === channel)
      .map(({ report }) => report!);
    const newEvents = input.state.since_summary[channel] + eventCounts[channel];
    // 非公開ホストが無く出来事も無い日は、 非公開側の要約を作らない。
    if (channel === 'private' && reports.length === 0 && newEvents === 0) continue;
    for (const content of formatDailySummary({ date, newEvents, reports, sources: input.sources })) {
      messages.push({ channel, content });
    }
  }
  return { messages, eventCounts, summaryDate: date };
}
