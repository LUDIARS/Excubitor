import { describe, expect, it } from 'vitest';

import packContract from '../update/ergo-watch/contracts/pack-messages.contract.js';
import { DISCORD_MESSAGE_LIMIT, packDiscordMessages, splitDiscordBlock } from './discord-messages.js';

describe('packDiscordMessages', () => {
  it('joins small blocks into one message', () => {
    const blocks = ['a', 'b', 'c'];
    const messages = packDiscordMessages(blocks);
    expect(messages).toEqual(['a\n\nb\n\nc']);
    expect(packContract.post(messages, blocks)).toBe(true);
  });

  it('splits many blocks and one oversized block below the limit without dropping content', () => {
    const blocks = [
      ...Array.from({ length: 30 }, (_, index) => `block ${index} ${'y'.repeat(120)}`),
      Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n'),
      'z'.repeat(DISCORD_MESSAGE_LIMIT * 2 + 10),
    ];
    const messages = packDiscordMessages(blocks);
    expect(messages.length).toBeGreaterThan(3);
    expect(messages.every((message) => message.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
    expect(packContract.post(messages, blocks)).toBe(true);
  });
});

describe('splitDiscordBlock', () => {
  it('never yields a chunk longer than the limit when a separator sits right after it', () => {
    const block = `${'a'.repeat(16)} ${'b'.repeat(14)}\n${'c'.repeat(15)}`;
    const chunks = splitDiscordBlock(block, 15);
    expect(chunks.every((chunk) => chunk.length <= 15)).toBe(true);
    expect(chunks.join('')).toBe(`${'a'.repeat(16)}${'b'.repeat(14)}${'c'.repeat(15)}`);
  });

  it('prefers line breaks', () => {
    const block = `${'a'.repeat(10)}\n${'b'.repeat(10)}`;
    expect(splitDiscordBlock(block, 15)).toEqual(['a'.repeat(10), 'b'.repeat(10)]);
  });
});
