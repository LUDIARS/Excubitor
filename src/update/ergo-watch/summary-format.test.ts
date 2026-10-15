import { describe, expect, it } from 'vitest';

import { DISCORD_MESSAGE_LIMIT } from '../../notify/discord-messages.js';
import runTextContract from './contracts/run-text.contract.js';
import { findSecretLeaks } from './redact.js';
import { NO_NEW_EVENTS, formatDailySummary, formatRunText } from './summary-format.js';
import { sampleEvents, sampleReport } from './test-fixtures.js';

describe('formatRunText', () => {
  it('says 新規なし when the run has no events', () => {
    const text = formatRunText(0, []);
    expect(text).toBe(NO_NEW_EVENTS);
    expect(runTextContract.post(text, 0, [])).toBe(true);
  });

  it('lists the messages when the run has events', () => {
    const text = formatRunText(2, ['a', 'b']);
    expect(text).toBe('a\n\nb');
    expect(runTextContract.post(text, 2, ['a', 'b'])).toBe(true);
  });
});

describe('formatDailySummary', () => {
  it('says 新規なし when nothing new arrived since the last summary', () => {
    const [message] = formatDailySummary({
      date: '2026-10-15',
      newEvents: 0,
      reports: [sampleReport('Ln')],
      sources: { concordia: 'ok', revisor: 'unavailable' },
    });
    expect(message).toContain('日次要約 — 2026-10-15');
    expect(message).toContain(NO_NEW_EVENTS);
    expect(message).toContain('Revisor 届かない');
    expect(message).toContain('**Ln** — 未解消なし');
  });

  it('summarises pending entries per host without secrets and within the limit', () => {
    const pending = sampleEvents().events.map((event) => ({ ...event, first_seen: event.at }));
    const many = Array.from({ length: 40 }, (_, index) => sampleReport(`H${index}`, pending));
    const messages = formatDailySummary({ date: '2026-10-15', newEvents: 4, reports: many, sources: null });
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
    const text = messages.join('\n');
    expect(text).toContain('新しい出来事 4 件');
    expect(text).toContain('未解消 4 件 (新しいタグ 1 / main の更新 1 / 審査中 1 / 作業中の委託 1)');
    expect(findSecretLeaks(text)).toEqual([]);
  });
});
