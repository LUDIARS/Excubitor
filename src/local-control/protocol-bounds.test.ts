import { describe, expect, it } from 'vitest';
import {
  boundControlResult,
  failedResponse,
  LOCAL_CONTROL_MAX_LINE_BYTES,
  LocalControlResponseSchema,
} from './protocol.js';

describe('local-control response bounds', () => {
  it('rejects contradictory response state, success, payload, and error combinations', () => {
    const base = { protocol_version: 1, operation_id: 'invalid-combination' };
    expect(LocalControlResponseSchema.safeParse({
      ...base,
      ok: true,
      state: 'failed',
      error: { code: 'FAILED', message: 'failed' },
    }).success).toBe(false);
    expect(LocalControlResponseSchema.safeParse({
      ...base,
      ok: false,
      state: 'completed',
      error: { code: 'FAILED', message: 'failed' },
    }).success).toBe(false);
    expect(LocalControlResponseSchema.safeParse({
      ...base,
      ok: true,
      state: 'accepted',
      payload: { kind: 'excubitor-status', state: 'running' },
    }).success).toBe(false);
    expect(LocalControlResponseSchema.safeParse({
      ...base,
      ok: true,
      state: 'completed',
      payload: { kind: 'accepted', deferred: true, target_key: 'excubitor' },
    }).success).toBe(false);
  });

  it('bounds JSON-escaped command output below the IPC frame limit', () => {
    const result = boundControlResult({
      ok: false,
      stdout: '\u0000'.repeat(100_000),
      stderr: '"\\'.repeat(100_000),
      exit_code: 1,
      command: '\u0001'.repeat(20_000),
    });
    const response = failedResponse(
      'bounded-operation',
      'CONTROL_FAILED',
      '\u0002'.repeat(100_000),
      { kind: 'control-result', value: result },
    );

    expect(result.stdout_truncated).toBe(true);
    expect(result.stderr_truncated).toBe(true);
    expect(result.command_truncated).toBe(true);
    expect(() => LocalControlResponseSchema.parse(response)).not.toThrow();
    expect(Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8')).toBeLessThanOrEqual(
      LOCAL_CONTROL_MAX_LINE_BYTES,
    );
  });

  it('does not split a UTF-16 surrogate pair at the truncation boundary', () => {
    const result = boundControlResult({
      ok: true,
      stdout: '😀'.repeat(100_000),
      stderr: '',
      exit_code: 0,
      command: 'test',
    });

    const last = result.stdout.charCodeAt(result.stdout.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  });
});
