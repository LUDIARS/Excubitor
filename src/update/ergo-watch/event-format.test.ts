import { describe, expect, it } from 'vitest';

import { DISCORD_MESSAGE_LIMIT } from '../../notify/discord-messages.js';
import eventMessageContract from './contracts/event-message.contract.js';
import { formatEventMessage } from './event-format.js';
import { findSecretLeaks } from './redact.js';
import { sampleEvent, sampleEvents } from './test-fixtures.js';

describe('formatEventMessage', () => {
  it('renders every sample event without secrets, titles or branch names', () => {
    for (const event of sampleEvents().events) {
      const messages = formatEventMessage(event);
      expect(eventMessageContract.post(messages, event)).toBe(true);
      const text = messages.join('\n');
      expect(findSecretLeaks(text)).toEqual([]);
      expect(text).not.toMatch(/example\.invalid|token=|abc123|D:\/work|secret task title|secret-branch/);
    }
  });

  it('does not show the run id', () => {
    const event = sampleEvent('run');
    expect(formatEventMessage(event).join('\n')).not.toContain(event.subject);
  });

  it('shows the tag, the current pin, distance, owner, next step and STRICT', () => {
    const [message] = formatEventMessage(sampleEvent('tag'));
    expect(message).toContain('Ln の依存 pictor (Pc) に新しいタグ `v2.3.0`');
    expect(message).toContain('`v2.2.0 / 625d83d`');
    expect(message).toContain('41 コミット先');
    expect(message).toContain('Ergo のマニフェスト');
    expect(message).toContain('`ergo_pkg update pictor --to v2.3.0`');
    expect(message).toContain('STRICT で通ります');
  });

  it('shortens full SHAs and mentions the folded distance for track', () => {
    const [message] = formatEventMessage(sampleEvent('track'));
    expect(message).toContain('`2222222`');
    expect(message).not.toMatch(/[0-9a-f]{40}/);
    expect(message).toContain('前回の通知から +5');
    expect(message).toContain('STRICT では通りません');
  });

  it('shows the local PR number, origin and head for review', () => {
    const [message] = formatEventMessage(sampleEvent('review'));
    expect(message).toContain('Revisor local PR #128');
    expect(message).toContain('由来: AI の委託');
    expect(message).toContain('`4f0e9a1`');
    expect(message).toContain('マージ後に main の更新として知らせます');
  });

  it('splits an oversized event below the Discord limit', () => {
    const event = { ...sampleEvent('tag'), next: `ergo_pkg update pictor --to v2.3.0 ${'x '.repeat(1500)}` };
    const messages = formatEventMessage(event);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
    expect(eventMessageContract.post(messages, event)).toBe(true);
  });
});
