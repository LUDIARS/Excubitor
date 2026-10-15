import { describe, expect, it } from 'vitest';

import {
  buildPackageUpdateBatches,
  newRunId,
  PACKAGE_UPDATE_MAX_MESSAGES,
  queueConcordiaBatches,
} from './concordia-batches.js';
import { packageUpdateBody } from './concordia-deliver.js';
import batchesContract from './contracts/package-update-batches.contract.js';
import queueContract from './contracts/queue-batches.contract.js';
import { emptyDeliveryState } from './delivery-state.js';
import type { DeliveryMessage } from './types.js';

const message = (content: string, channel: DeliveryMessage['channel'] = 'public'): DeliveryMessage => ({ channel, content });

describe('buildPackageUpdateBatches', () => {
  it('keeps the formatted text and marks private messages', () => {
    const messages = [message('a'), message('🔒 b', 'private')];
    const batches = buildPackageUpdateBatches('run-1', messages);
    expect(batches).toEqual([{ runId: 'run-1', messages: [{ text: 'a', private: false }, { text: '🔒 b', private: true }] }]);
    expect(batchesContract.post(batches, 'run-1', messages)).toBe(true);
  });

  it('splits more than 20 messages into numbered batches without losing order', () => {
    const messages = Array.from({ length: PACKAGE_UPDATE_MAX_MESSAGES * 2 + 1 }, (_, index) => message(`m${index}`));
    const batches = buildPackageUpdateBatches('run-2', messages);
    expect(batches.map((batch) => batch.runId)).toEqual(['run-2#1', 'run-2#2', 'run-2#3']);
    expect(batches.map((batch) => batch.messages.length)).toEqual([20, 20, 1]);
    expect(batchesContract.post(batches, 'run-2', messages)).toBe(true);
  });

  it('builds nothing for a run without messages', () => {
    expect(buildPackageUpdateBatches('run-3', [])).toEqual([]);
  });

  it('serializes the strict body Concordia expects', () => {
    const [batch] = buildPackageUpdateBatches('run-4', [message('hello', 'private')]);
    expect(JSON.parse(packageUpdateBody(batch!))).toEqual({
      source: 'ergo-watch',
      runId: 'run-4',
      messages: [{ text: 'hello', private: true }],
    });
  });
});

describe('newRunId', () => {
  it('is a short id derived from the run time', () => {
    const runId = newRunId(new Date('2026-10-15T01:02:03.456Z'), () => 'abcdef12-3456-7890-abcd-ef1234567890');
    expect(runId).toBe('ergo-watch-20261015T010203Z-abcdef12');
    expect(runId.length).toBeLessThanOrEqual(128);
  });
});

describe('queueConcordiaBatches', () => {
  it('resends unsent batches first with their original runId', () => {
    const state = {
      ...emptyDeliveryState(),
      concordia_outbox: [{ run_id: 'old-run', messages: [{ text: 'old', private: false }] }],
    };
    const messages = [message('new')];
    const batches = queueConcordiaBatches(state, 'new-run', messages);
    expect(batches.map((batch) => batch.runId)).toEqual(['old-run', 'new-run']);
    expect(queueContract.post(batches, state, 'new-run', messages)).toBe(true);
  });

  it('adds no batch on a run without events', () => {
    const state = emptyDeliveryState();
    const batches = queueConcordiaBatches(state, 'idle-run', []);
    expect(batches).toEqual([]);
    expect(queueContract.post(batches, state, 'idle-run', [])).toBe(true);
  });

  it('moves the webhook outbox into this run when switching to Concordia', () => {
    const state = { ...emptyDeliveryState(), outbox: [message('left', 'private')] };
    const batches = queueConcordiaBatches(state, 'run-5', [message('new')]);
    expect(batches).toEqual([{
      runId: 'run-5',
      messages: [{ text: 'left', private: true }, { text: 'new', private: false }],
    }]);
  });
});
