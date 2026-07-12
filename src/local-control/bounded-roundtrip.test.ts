import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { requestLocalControl } from './client.js';
import { boundControlResult, failedResponse } from './protocol.js';
import { LocalControlServer } from './server.js';

const servers: LocalControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('bounded local-control round trip', () => {
  it('returns high-volume stdout and stderr through the 64 KiB client framer', async () => {
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\excubitor-bounded-test-${randomUUID()}`
      : join(tmpdir(), `excubitor-bounded-test-${randomUUID()}.sock`);
    const result = boundControlResult({
      ok: false,
      stdout: '\u0000'.repeat(100_000),
      stderr: '"\\'.repeat(100_000),
      exit_code: 1,
      command: 'compose '.repeat(10_000),
    });
    const server = new LocalControlServer({
      endpoint,
      handler: async (request) => ({
        response: failedResponse(
          request.operation_id,
          'CONTROL_FAILED',
          result.stderr,
          { kind: 'control-result', value: result },
        ),
      }),
    });
    servers.push(server);
    await server.listen();

    const response = await requestLocalControl({
      operation_id: 'bounded-roundtrip',
      target: { kind: 'service', code: 'test-service' },
      action: 'restart',
    }, { endpoint });

    expect(response.ok).toBe(false);
    expect(response.payload?.kind).toBe('control-result');
    if (response.payload?.kind === 'control-result') {
      expect(response.payload.value.stdout_truncated).toBe(true);
      expect(response.payload.value.stderr_truncated).toBe(true);
      expect(response.payload.value.command_truncated).toBe(true);
    }
  });
});
