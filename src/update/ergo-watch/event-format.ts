/**
 * 出来事 1 件を Discord 本文 1 件へ整形する (1 出来事 1 件)。
 *
 * 載せるもの: ホストのコード、 依存名とコード、 持ち主、 種類、 前後の版 (タグと SHA7)、 距離、 由来、
 * local PR の番号、 次の操作、 STRICT で通るか (Ergo spec §4)。 run id・PR のタイトル・本文・ブランチ名は載せない。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { DISCORD_MESSAGE_LIMIT, splitDiscordBlock } from '../../notify/discord-messages.js';
import {
  code,
  dependencyLabel,
  originLabel,
  ownerLabel,
  pinLabel,
  plain,
  sha7,
} from './labels.js';
import type { WatchEvent } from './types.js';

/** 出来事 1 件の本文。 上限を超えるときだけ複数に分かれる。 */
export function formatEventMessage(event: WatchEvent): string[] {
  const lines = [headline(event), ...detailLines(event)].filter(Boolean);
  return splitDiscordBlock(lines.join('\n'), DISCORD_MESSAGE_LIMIT);
}

function headline(event: WatchEvent): string {
  const host = plain(event.host);
  const dep = dependencyLabel(event.dependency, event.code);
  const prefix = event.private ? '🔒 ' : '';
  switch (event.kind) {
    case 'tag':
      return `${prefix}**${host} の依存 ${dep} に新しいタグ ${code(event.to_tag)}** (今の pin は ${pinLabel(event.from_tag, event.from_rev)}${behindText(event.behind)})`;
    case 'track':
      return `${prefix}**${host} の依存 ${dep} の追跡ブランチが進みました** (先頭 ${code(sha7(event.to_rev))}、今の pin は ${pinLabel(event.from_tag, event.from_rev)}${behindText(event.behind)}${sinceNotifiedText(event.since_notified)})`;
    case 'off-main':
      return `${prefix}⚠️ **${host} の依存 ${dep} の pin が追跡ブランチ上にありません** (pin ${pinLabel(event.from_tag, event.from_rev)}、追跡ブランチの先頭 ${code(sha7(event.to_rev))})`;
    case 'run':
      return `${prefix}**${host} の依存 ${dep} を対象にした委託が進行中** (由来: ${originLabel(event.origin, event.trigger)})`;
    case 'review':
      return `${prefix}**${host} の依存 ${dep} に審査中の更新** (Revisor local PR ${reviewNumber(event.review)}、由来: ${originLabel(event.origin, event.trigger)}、head ${code(event.head)})`;
    case 'merged':
      return `${prefix}**${host} の依存 ${dep} の更新がマージされました** (Revisor local PR ${reviewNumber(event.review)}、由来: ${originLabel(event.origin, event.trigger)}${event.to_rev ? `、main ${code(sha7(event.to_rev))}` : ''})`;
  }
}

function detailLines(event: WatchEvent): string[] {
  const lines: string[] = [];
  const owner = `持ち主: ${ownerLabel(event.owner)}`;
  if (event.kind === 'review') {
    lines.push(`${owner}。マージ後に main の更新として知らせます。`);
    return lines;
  }
  if (event.kind === 'run') {
    lines.push(`${owner}。審査に出たら審査中の更新として知らせます。`);
    return lines;
  }
  const next = event.next.trim() ? ` → 次の操作: ${code(event.next)}` : '';
  lines.push(`${owner}${next}`);
  if (event.kind === 'tag' || event.kind === 'track') {
    lines.push(event.strict_ok ? 'STRICT で通ります。' : 'STRICT では通りません (タグの無い pin になります)。');
  }
  if (event.as_of === 'sibling-last-fetch') lines.push('値は兄弟チェックアウトの最後の fetch 時点です。');
  return lines;
}

function behindText(behind: number | null): string {
  return behind == null ? '' : `、${behind} コミット先`;
}

function sinceNotifiedText(sinceNotified: number | null): string {
  return sinceNotified == null ? '' : `、前回の通知から +${sinceNotified}`;
}

function reviewNumber(review: number | null): string {
  return review == null ? '—' : `#${review}`;
}
