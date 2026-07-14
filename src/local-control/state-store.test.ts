import { describe, expect, it } from 'vitest';
import { LocalControlStateStore } from './state-store.js';
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type ExcubitorStatusPayload,
  type LocalControlResponse,
} from './protocol.js';

describe('LocalControlStateStore', () => {
  it('recovers its write queue after a transient persistence failure', async () => {
    let attempt = 0;
    const persisted: string[] = [];
    const store = new LocalControlStateStore('unused-in-injected-test.json', {
      persistState: async (state) => {
        attempt += 1;
        if (attempt === 2) throw new Error('disk temporarily unavailable');
        persisted.push(JSON.stringify(state));
      },
    });

    await store.initialize({ pid: 1234, startedAt: '2026-07-12T00:00:00.000Z' });
    await expect(store.recordExcubitor(status('running'))).rejects.toThrow('disk temporarily unavailable');
    await expect(store.recordExcubitor(status('stopped'))).resolves.toBeUndefined();

    expect(attempt).toBe(3);
    expect(JSON.parse(persisted.at(-1) ?? '{}').excubitor.state).toBe('stopped');
  });

  it('rolls back an acceptance whose durable write failed', async () => {
    let attempt = 0;
    const store = new LocalControlStateStore('unused-in-injected-test.json', {
      persistState: async () => {
        attempt += 1;
        if (attempt === 2) throw new Error('accept write failed');
      },
    });
    await store.initialize({ pid: 1234, startedAt: '2026-07-12T00:00:00.000Z' });

    await expect(store.recordAccepted(
      'retryable-operation',
      'excubitor',
      'restart',
      '2026-07-12T00:00:01.000Z',
      accepted('retryable-operation'),
      'test-actor',
      'prepare',
    )).rejects.toThrow('accept write failed');
    expect(store.getOperation('retryable-operation')).toBeUndefined();

    await expect(store.recordAccepted(
      'retryable-operation',
      'excubitor',
      'restart',
      '2026-07-12T00:00:02.000Z',
      accepted('retryable-operation'),
      'test-actor',
      'prepare',
    )).resolves.toBeUndefined();
    expect(store.getOperation('retryable-operation')).toMatchObject({
      actor: 'test-actor',
      dispatch: 'prepare',
    });
  });

  it('keeps an externally completed result in memory when its durable write fails', async () => {
    let attempt = 0;
    const store = new LocalControlStateStore('unused-in-injected-test.json', {
      persistState: async () => {
        attempt += 1;
        if (attempt === 3) throw new Error('completion write failed');
      },
    });
    await store.initialize({ pid: 1234, startedAt: '2026-07-12T00:00:00.000Z' });
    await store.recordAccepted(
      'completed-operation',
      'excubitor',
      'restart',
      '2026-07-12T00:00:01.000Z',
      accepted('completed-operation'),
    );

    await expect(store.recordCompleted(
      'completed-operation',
      '2026-07-12T00:00:02.000Z',
      completed('completed-operation'),
    )).rejects.toThrow('completion write failed');
    expect(store.getOperation('completed-operation')?.response.state).toBe('completed');
  });
});

function status(state: ExcubitorStatusPayload['state']): ExcubitorStatusPayload {
  return {
    kind: 'excubitor-status',
    state,
    desired_state: state === 'stopped' ? 'stopped' : 'running',
    pid: state === 'stopped' ? null : 4321,
    restart_count: 0,
    last_exit_code: null,
    last_signal: null,
    last_error: null,
    instance_token: state === 'stopped' ? null : 'test-token',
  };
}

function accepted(operationId: string): LocalControlResponse {
  return {
    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation_id: operationId,
    ok: true,
    state: 'accepted',
    payload: { kind: 'accepted', deferred: true, target_key: 'excubitor' },
  };
}

function completed(operationId: string): LocalControlResponse {
  return {
    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation_id: operationId,
    ok: true,
    state: 'completed',
    payload: status('running'),
  };
}
