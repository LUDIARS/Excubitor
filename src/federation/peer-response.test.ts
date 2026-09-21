import { describe, expect, it } from 'vitest';
import { classifyPeerResponse } from './peer-response.js';
import { healthPayload } from './test-fixtures.js';

describe('classifyPeerResponse', () => {
  it('accepts a payload that matches the contract', () => {
    const payload = healthPayload('mac');
    expect(classifyPeerResponse({ ok: true, status: 200, data: payload, error: null }, 15)).toEqual({
      ok: true, status: 'up', latency_ms: 15, error: null, payload,
    });
  });

  it('treats a token mismatch as unauthorized, not as the peer being down', () => {
    expect(classifyPeerResponse({ ok: false, status: 401, data: null, error: 'HTTP 401' }, 9)).toMatchObject({
      ok: false, status: 'unauthorized', latency_ms: 9,
    });
  });

  it('reports unreachable peers as down without a latency', () => {
    expect(classifyPeerResponse({ ok: false, status: null, data: null, error: 'fetch failed' }, 5_000)).toEqual({
      ok: false, status: 'down', latency_ms: null, error: 'fetch failed', payload: null,
    });
  });

  it('does not pass through a payload that breaks the contract', () => {
    const outcome = classifyPeerResponse({ ok: true, status: 200, data: { ...healthPayload('mac'), node: 123 }, error: null }, 3);
    expect(outcome).toMatchObject({ ok: false, status: 'down', payload: null });
    expect(outcome.error).toMatch(/invalid health payload/);
  });

  it('rejects a payload from a different schema version and says to update the peer', () => {
    const outcome = classifyPeerResponse({ ok: true, status: 200, data: { ...healthPayload('mac'), schema: 1 }, error: null }, 3);
    expect(outcome).toMatchObject({ ok: false, status: 'down' });
    expect(outcome.error).toMatch(/incompatible health schema \(peer=1, local=2\)/);
  });

  it('tells a missing mutual registration apart from a wrong token', () => {
    const notRegistered = classifyPeerResponse(
      { ok: false, status: 403, data: { error: 'peer_not_registered' }, error: 'HTTP 403 peer_not_registered' }, 4,
    );
    expect(notRegistered).toMatchObject({ ok: false, status: 'unregistered' });
    const forbidden = classifyPeerResponse({ ok: false, status: 403, data: { error: 'forbidden' }, error: 'HTTP 403' }, 4);
    expect(forbidden.status).toBe('unauthorized');
  });
});
