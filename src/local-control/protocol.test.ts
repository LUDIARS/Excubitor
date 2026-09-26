import { describe, expect, it } from 'vitest';
import { NewlineJsonFramer } from './line-framer.js';
import {
  ExcubitorStatusPayloadSchema,
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LocalControlRequestSchema,
  LocalControlResponseSchema,
} from './protocol.js';

describe('local-control protocol', () => {
  it('accepts a versioned service command', () => {
    const request = LocalControlRequestSchema.parse({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'operation-001',
      target: { kind: 'service', code: 'concordia' },
      action: 'restart',
      actor: 'test',
    });

    expect(request.target).toEqual({ kind: 'service', code: 'concordia' });
  });

  it('rejects unknown versions and invalid response/error combinations', () => {
    expect(LocalControlRequestSchema.safeParse({
      protocol_version: 2,
      operation_id: 'operation-002',
      target: { kind: 'excubitor' },
      action: 'status',
      actor: 'test',
    }).success).toBe(false);

    expect(LocalControlResponseSchema.safeParse({
      protocol_version: 1,
      operation_id: 'operation-002',
      ok: false,
      state: 'failed',
    }).success).toBe(false);
  });

  it('reads a persisted Excubitor status written before last_startup_ms existed', () => {
    const legacy = {
      kind: 'excubitor-status',
      state: 'running',
      desired_state: 'running',
      pid: 4321,
      restart_count: 0,
      last_exit_code: null,
      last_signal: null,
      last_error: null,
      instance_token: 'token',
    };
    expect(ExcubitorStatusPayloadSchema.parse(legacy).last_startup_ms).toBeNull();
    expect(ExcubitorStatusPayloadSchema.parse({ ...legacy, last_startup_ms: 26_400 }).last_startup_ms).toBe(26_400);
    expect(ExcubitorStatusPayloadSchema.safeParse({ ...legacy, last_startup_ms: -1 }).success).toBe(false);
  });

  it('frames fragmented CRLF and LF JSON without changing payloads', () => {
    const framer = new NewlineJsonFramer();
    expect(framer.push('{"a":1}\r')).toEqual([]);
    expect(framer.push('\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});
