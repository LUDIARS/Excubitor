import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestLocalControl } from './client.js';
import { LocalControlServer } from './server.js';

let endpointSequence = 0;

describe('local-control client/server', () => {
  it('round-trips one validated newline-JSON response', async () => {
    const endpoint = testEndpoint();
    const server = new LocalControlServer({
      endpoint,
      handler: async (request) => ({
        response: {
          protocol_version: 1,
          operation_id: request.operation_id,
          ok: true,
          state: 'completed',
          payload: {
            kind: 'service-status',
            code: 'demo',
            runtime: 'node',
            state: 'stopped',
            running: false,
            pid: null,
          },
        },
      }),
    });
    await server.listen();
    try {
      const response = await requestLocalControl({
        operation_id: 'client-roundtrip-001',
        target: { kind: 'service', code: 'demo' },
        action: 'status',
        actor: 'test',
      }, { endpoint, timeoutMs: 2_000 });
      expect(response.operation_id).toBe('client-roundtrip-001');
      expect(response.payload?.kind).toBe('service-status');
    } finally {
      await server.close();
    }
  });

  it('schedules a deferred action only after the acknowledgement is written', async () => {
    const endpoint = testEndpoint();
    let scheduled: (() => void) | undefined;
    let restarted = false;
    let resolveScheduled: (() => void) | undefined;
    const scheduledReady = new Promise<void>((resolve) => { resolveScheduled = resolve; });
    const server = new LocalControlServer({
      endpoint,
      scheduleAfterReply: (task) => {
        scheduled = task;
        resolveScheduled?.();
      },
      handler: async (request) => ({
        response: {
          protocol_version: 1,
          operation_id: request.operation_id,
          ok: true,
          state: 'accepted',
          payload: { kind: 'accepted', deferred: true, target_key: 'excubitor' },
        },
        afterReply: () => { restarted = true; },
      }),
    });
    await server.listen();
    try {
      const response = await requestLocalControl({
        operation_id: 'deferred-restart-001',
        target: { kind: 'excubitor' },
        action: 'restart',
        actor: 'test',
      }, { endpoint, timeoutMs: 2_000 });
      expect(response.state).toBe('accepted');
      expect(restarted).toBe(false);
      await scheduledReady;
      expect(scheduled).toBeTypeOf('function');
      scheduled?.();
      expect(restarted).toBe(true);
    } finally {
      await server.close();
    }
  });
});

function testEndpoint(): string {
  endpointSequence += 1;
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\excubitor-control-test-${process.pid}-${endpointSequence}`;
  }
  return join(tmpdir(), `excubitor-control-test-${process.pid}-${endpointSequence}.sock`);
}
