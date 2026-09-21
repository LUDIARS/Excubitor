import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPeerStates,
  getPeerState,
  pendingPeerState,
  prunePeerStates,
  recordPeerPoll,
  toPeerLink,
} from './peer-cache.js';
import { healthPayload } from './test-fixtures.js';

const peer = { id: 'p1', name: 'Mac 登録名' };

beforeEach(() => {
  clearPeerStates();
});

describe('peer cache', () => {
  it('keeps the last good payload when a later poll fails', () => {
    const payload = healthPayload('mac');
    recordPeerPoll(peer, { ok: true, status: 'up', latency_ms: 10, error: null, payload }, 1_000);
    const failed = recordPeerPoll(peer, { ok: false, status: 'down', latency_ms: null, error: 'timeout', payload: null }, 2_000);

    expect(failed).toMatchObject({
      status: 'down', error: 'timeout', checked_at: 2_000, last_ok_at: 1_000,
      payload, payload_received_at: 1_000,
    });
  });

  it('names the link after the node the peer reports, falling back to the registered name', () => {
    expect(toPeerLink(pendingPeerState(peer))).toMatchObject({ node: 'Mac 登録名', status: 'pending' });
    const state = recordPeerPoll(peer, { ok: true, status: 'up', latency_ms: 4, error: null, payload: healthPayload('kaoimac') }, 1_000);
    expect(toPeerLink(state)).toEqual({
      node: 'kaoimac', status: 'up', latency_ms: 4, checked_at: 1_000, last_ok_at: 1_000, error: null,
    });
  });

  it('drops peers that were deleted or disabled', () => {
    recordPeerPoll(peer, { ok: true, status: 'up', latency_ms: 1, error: null, payload: null }, 1_000);
    prunePeerStates(new Set());
    expect(getPeerState('p1')).toBeNull();
  });
});
