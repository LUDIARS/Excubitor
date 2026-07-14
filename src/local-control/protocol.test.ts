import { describe, expect, it } from 'vitest';
import { NewlineJsonFramer } from './line-framer.js';
import {
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

  it('frames fragmented CRLF and LF JSON without changing payloads', () => {
    const framer = new NewlineJsonFramer();
    expect(framer.push('{"a":1}\r')).toEqual([]);
    expect(framer.push('\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});
