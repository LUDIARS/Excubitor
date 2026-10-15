/**
 * Discord の 1 メッセージ上限 (2,000 字) に収まるよう本文を分割・結合する。
 *
 * package-update-audit と ergo-watch の配送ジョブで共用する。 上限は余白を残して 1,900 字。
 * 1 ブロックが上限を超えるときは改行 → 空白 → 固定長の順で切り、 内容を落とさない。
 */

export const DISCORD_MESSAGE_LIMIT = 1_900;

/** 1 ブロックを上限以下の断片へ分ける。 */
export function splitDiscordBlock(block: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = block;
  while (remaining.length > limit) {
    // 区切りは limit 以下の位置で探す (limit + 1 だと切り出した断片が limit + 1 字になる)。
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** ブロック列を空行区切りで詰め、 上限以下のメッセージ列にする。 */
export function packDiscordMessages(blocks: string[], limit = DISCORD_MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current = '';
  for (const unsplitBlock of blocks) {
    for (const block of splitDiscordBlock(unsplitBlock, limit)) {
      if (!current) {
        current = block;
        continue;
      }
      if (`${current}\n\n${block}`.length <= limit) {
        current = `${current}\n\n${block}`;
      } else {
        messages.push(current);
        current = block;
      }
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** Discord の書式記号をエスケープする。 */
export function escapeDiscord(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
}
