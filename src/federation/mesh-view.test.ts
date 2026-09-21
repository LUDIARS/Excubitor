import { describe, expect, it } from 'vitest';
import { buildMeshView, coverageIssues } from './mesh-view.js';
import type { PeerPollState } from './peer-cache.js';
import { healthPayload, serviceHealth } from './test-fixtures.js';

const NOW = 100_000;
const STALE_MS = 180_000;

function peerState(overrides: Partial<PeerPollState> & { peer_id: string; name: string }): PeerPollState {
  return {
    status: 'up',
    latency_ms: 12,
    checked_at: NOW,
    last_ok_at: NOW,
    error: null,
    payload: null,
    payload_received_at: NOW,
    ...overrides,
  };
}

describe('buildMeshView', () => {
  it('lists self and peers with reachability and coverage counts', () => {
    const self = healthPayload('win', {
      services: [serviceHealth('cernere'), serviceHealth('memoria', { health: { state: 'down' } })],
      links: [{ node: 'mac', status: 'up', latency_ms: 8, checked_at: NOW, last_ok_at: NOW, error: null }],
    });
    const mac = healthPayload('mac', {
      services: [serviceHealth('postgres', { kind: 'observed' })],
      links: [{ node: 'win', status: 'down', latency_ms: null, checked_at: NOW, last_ok_at: null, error: 'fetch failed' }],
    });

    const view = buildMeshView({
      now: NOW,
      staleAfterMs: STALE_MS,
      self,
      peers: [peerState({ peer_id: 'p1', name: 'Mac 登録名', payload: mac })],
    });

    expect(view.self).toBe('win');
    expect(view.nodes).toEqual([
      expect.objectContaining({ node: 'win', is_self: true, status: 'up', covered_total: 2, covered_down: 1 }),
      expect.objectContaining({ node: 'mac', peer_id: 'p1', status: 'up', stale: false, covered_total: 1, latency_ms: 12 }),
    ]);
    // メッシュの向きは別々に見える (win→mac は up、 mac→win は down)。
    expect(view.links).toEqual([
      expect.objectContaining({ from: 'mac', node: 'win', status: 'down', reported_by: 'mac' }),
      expect.objectContaining({ from: 'win', node: 'mac', status: 'up', reported_by: 'win' }),
    ]);
  });

  it('flags a service that two nodes both manage', () => {
    const view = buildMeshView({
      now: NOW,
      staleAfterMs: STALE_MS,
      self: healthPayload('win', { services: [serviceHealth('actio')] }),
      peers: [peerState({ peer_id: 'p1', name: 'mac', payload: healthPayload('mac', { services: [serviceHealth('actio')] }) })],
    });
    expect(view.coverage).toEqual([
      expect.objectContaining({ code: 'actio', managed_by: ['win', 'mac'], issues: ['duplicate_managed'] }),
    ]);
  });

  it('flags a service that is listed somewhere but covered nowhere', () => {
    const view = buildMeshView({
      now: NOW,
      staleAfterMs: STALE_MS,
      self: healthPayload('win', { services: [serviceHealth('villa', { covered: false, source: 'override' })] }),
      peers: [],
    });
    expect(view.coverage[0]).toMatchObject({ code: 'villa', managed_by: [], issues: ['uncovered'] });
  });

  it('marks a peer stale when its last payload is too old and keeps showing the old value', () => {
    const mac = healthPayload('mac', { services: [serviceHealth('postgres')] });
    const view = buildMeshView({
      now: NOW,
      staleAfterMs: 10_000,
      self: healthPayload('win'),
      peers: [peerState({
        peer_id: 'p1', name: 'mac', status: 'down', error: 'timeout',
        payload: mac, payload_received_at: NOW - 60_000,
      })],
    });
    expect(view.nodes[1]).toMatchObject({ node: 'mac', status: 'down', stale: true, error: 'timeout' });
    expect(view.coverage[0]!.nodes[0]).toMatchObject({ node: 'mac', stale: true });
  });

  it('shows a peer that has never answered under its registered name', () => {
    const view = buildMeshView({
      now: NOW,
      staleAfterMs: STALE_MS,
      self: healthPayload('win'),
      peers: [peerState({
        peer_id: 'p1', name: 'office', status: 'pending', checked_at: null, last_ok_at: null,
        latency_ms: null, payload: null, payload_received_at: null,
      })],
    });
    expect(view.nodes[1]).toMatchObject({ node: 'office', status: 'pending', stale: true, services_total: 0 });
  });
});

describe('coverageIssues', () => {
  const entry = { kind: 'managed' as const, source: 'catalog' as const, checked_at: 1, stale: false };

  it('reports down only when no covering node sees the service up', () => {
    expect(coverageIssues({
      managed_by: ['a'],
      nodes: [{ ...entry, node: 'a', covered: true, health: 'down' }],
    })).toEqual(['down']);
    expect(coverageIssues({
      managed_by: ['a'],
      nodes: [
        { ...entry, node: 'a', covered: true, health: 'down' },
        { ...entry, node: 'b', covered: true, health: 'up', kind: 'observed' },
      ],
    })).toEqual([]);
  });

  it('does not call an unmonitored service down', () => {
    expect(coverageIssues({
      managed_by: ['a'],
      nodes: [{ ...entry, node: 'a', covered: true, health: 'unmonitored' }],
    })).toEqual([]);
  });
});
