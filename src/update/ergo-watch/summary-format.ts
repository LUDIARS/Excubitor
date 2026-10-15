/**
 * 日次要約 1 本と、 各回の結果表示を整形する。
 *
 * 出来事 0 件の回は Discord へ送らない (15 分ごとに空の投稿をしない)。 その回の表示と、 前回の要約以降に
 * 新しい出来事が無かった日の要約に「新規なし」と書く。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { packDiscordMessages } from '../../notify/discord-messages.js';
import { code, dependencyLabel, plain, sha7 } from './labels.js';
import type { PendingEntry, WatchReport, WatchSources } from './types.js';

export const NO_NEW_EVENTS = '新規なし';

const KIND_LABEL: Record<PendingEntry['kind'], string> = {
  tag: '新しいタグ',
  track: 'main の更新',
  'off-main': 'pin が追跡ブランチ外',
  run: '作業中の委託',
  review: '審査中',
  merged: 'マージ済み',
};

const SOURCE_LABEL: Record<WatchSources['revisor'], string> = {
  ok: '取得',
  unavailable: '届かない',
  off: '未設定',
};

const MAX_PENDING_LINES = 10;

export interface SummaryInput {
  /** ローカル日付 `YYYY-MM-DD`。 */
  date: string;
  /** 前回の要約以降にこの配送先へ出した出来事の数。 */
  newEvents: number;
  reports: WatchReport[];
  sources: WatchSources | null;
}

/** 日次要約。 1 本を上限で分割したメッセージ列。 */
export function formatDailySummary(input: SummaryInput): string[] {
  const blocks = [
    [
      `📦 **Ergo パッケージ更新 日次要約 — ${input.date}**`,
      input.newEvents > 0 ? `前回の要約以降の新しい出来事 ${input.newEvents} 件` : NO_NEW_EVENTS,
      ...(input.sources ? [sourcesLine(input.sources)] : []),
    ].join('\n'),
  ];
  if (input.reports.length === 0) blocks.push('監視中のホストの報告がありません。');
  for (const report of [...input.reports].sort((a, b) => a.host.localeCompare(b.host))) {
    blocks.push(hostBlock(report));
  }
  return packDiscordMessages(blocks);
}

/** 1 回の結果の表示 (CLI 出力)。 出来事 0 件なら先頭に「新規なし」。 */
export function formatRunText(eventCount: number, messages: string[]): string {
  return [...(eventCount === 0 ? [NO_NEW_EVENTS] : []), ...messages].join('\n\n');
}

function sourcesLine(sources: WatchSources): string {
  return `取得元: Revisor ${SOURCE_LABEL[sources.revisor]} / Concordia ${SOURCE_LABEL[sources.concordia]}`;
}

function hostBlock(report: WatchReport): string {
  const pending = report.pending;
  if (pending.length === 0) return `**${plain(report.host)}** — 未解消なし`;
  const counts = new Map<string, number>();
  for (const entry of pending) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .map(([kind, count]) => `${KIND_LABEL[kind as PendingEntry['kind']]} ${count}`)
    .join(' / ');
  const shown = pending.slice(0, MAX_PENDING_LINES);
  return [
    `**${plain(report.host)}** — 未解消 ${pending.length} 件 (${breakdown})`,
    ...shown.map(pendingLine),
    ...(shown.length < pending.length ? [`• ほか ${pending.length - shown.length} 件`] : []),
  ].join('\n');
}

function pendingLine(entry: PendingEntry): string {
  const dep = dependencyLabel(entry.dependency, '');
  const kind = KIND_LABEL[entry.kind];
  switch (entry.kind) {
    case 'tag':
      return `• ${dep}: ${kind} ${code(entry.to_tag)}`;
    case 'track':
    case 'off-main':
      return `• ${dep}: ${kind} ${code(sha7(entry.to_rev))}${entry.behind == null ? '' : ` (${entry.behind} 先)`}`;
    case 'review':
    case 'merged':
      return `• ${dep}: ${kind} ${entry.review == null ? '' : `#${entry.review}`}`.trimEnd();
    case 'run':
      return `• ${dep}: ${kind}`;
  }
}
