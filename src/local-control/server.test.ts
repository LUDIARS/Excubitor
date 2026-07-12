import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestLocalControl } from './client.js';
import { LocalControlServer } from './server.js';

describe('local-control server endpoint ownership', () => {
  it.skipIf(process.platform === 'win32')('serializes concurrent recovery of a stale Unix socket', async () => {
    const endpoint = join(tmpdir(), `excubitor-control-race-${process.pid}-${Date.now()}.sock`);
    await writeFile(endpoint, 'stale endpoint', 'utf8');
    const servers = [createStatusServer(endpoint), createStatusServer(endpoint)];

    try {
      const results = await Promise.allSettled(servers.map((server) => server.listen()));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      await expect(requestLocalControl({
        operation_id: 'single-endpoint-owner',
        target: { kind: 'service', code: 'demo' },
        action: 'status',
        actor: 'test',
      }, { endpoint, timeoutMs: 2_000 })).resolves.toMatchObject({
        ok: true,
        state: 'completed',
      });
    } finally {
      await Promise.allSettled(servers.map((server) => server.close()));
      await rm(endpoint, { force: true });
      await rm(`${endpoint}.startup-lock`, { recursive: true, force: true });
    }
  });
});

function createStatusServer(endpoint: string): LocalControlServer {
  return new LocalControlServer({
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
}
