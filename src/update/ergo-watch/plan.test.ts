import { describe, expect, it } from 'vitest';

import { deliverMessages } from './deliver.js';
import { emptyDeliveryState } from './delivery-state.js';
import { planDelivery } from './plan.js';
import { NO_NEW_EVENTS } from './summary-format.js';
import { sampleEvents, sampleReport } from './test-fixtures.js';

const publicHost = { dir: '/w/ln', serviceCodes: ['ln'], private: false };
const morning = new Date(2026, 9, 15, 10, 0, 0);
const night = new Date(2026, 9, 15, 3, 0, 0);

describe('planDelivery', () => {
  it('sends nothing on a run without events before the summary hour', () => {
    const plan = planDelivery({
      events: [],
      hostReports: [{ host: publicHost, report: sampleReport('Ln') }],
      sources: null,
      state: emptyDeliveryState(),
      now: night,
      summaryHour: 9,
    });
    expect(plan.messages).toEqual([]);
    expect(plan.summaryDate).toBeNull();
  });

  it('posts one message per event and one public summary once a day', () => {
    const events = sampleEvents().events;
    const plan = planDelivery({
      events,
      hostReports: [{ host: publicHost, report: sampleReport('Ln') }],
      sources: sampleEvents().sources,
      state: emptyDeliveryState(),
      now: morning,
      summaryHour: 9,
    });
    expect(plan.eventCounts).toEqual({ public: 3, private: 1 });
    expect(plan.summaryDate).toBe('2026-10-15');
    const summaries = plan.messages.filter((message) => message.content.includes('日次要約'));
    expect(summaries.map((message) => message.channel)).toEqual(['public', 'private']);
    expect(plan.messages).toHaveLength(events.length + 2);

    const again = planDelivery({
      events: [],
      hostReports: [{ host: publicHost, report: sampleReport('Ln') }],
      sources: null,
      state: { ...emptyDeliveryState(), last_summary_date: '2026-10-15' },
      now: morning,
      summaryHour: 9,
    });
    expect(again.messages).toEqual([]);
  });

  it('writes 新規なし in the summary of a day without events', () => {
    const plan = planDelivery({
      events: [],
      hostReports: [{ host: publicHost, report: sampleReport('Ln') }],
      sources: null,
      state: emptyDeliveryState(),
      now: morning,
      summaryHour: 9,
    });
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]).toMatchObject({ channel: 'public' });
    expect(plan.messages[0]!.content).toContain(NO_NEW_EVENTS);
  });
});

describe('deliverMessages', () => {
  it('withholds private messages without a private webhook and keeps unsent ones in order', async () => {
    const sent: string[] = [];
    let calls = 0;
    const result = await deliverMessages(
      [
        { channel: 'private', content: 'p1' },
        { channel: 'public', content: 'a' },
        { channel: 'public', content: 'b' },
        { channel: 'public', content: 'c' },
      ],
      { public: 'https://discord.com/api/webhooks/1/x', private: '' },
      async (_url, content) => {
        calls += 1;
        if (calls === 2) throw new Error('Discord webhook failed with HTTP 500');
        sent.push(content);
      },
    );
    expect(sent).toEqual(['a']);
    expect(result).toMatchObject({ sent: 1, withheld: 1, error: 'Discord webhook failed with HTTP 500' });
    expect(result.unsent.map((message) => message.content)).toEqual(['b', 'c']);
  });
});
