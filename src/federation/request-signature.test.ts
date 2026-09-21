import { describe, expect, it } from 'vitest';
import {
  NODE_HEADER,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalRequest,
  signRequest,
  signatureHeaders,
  verifyRequestSignature,
} from './request-signature.js';

const parts = { method: 'post', path: '/api/v1/federation/operations', timestamp: 1_000, nonce: 'n1', body: '{"a":1}' };

describe('request signature', () => {
  it('canonicalizes method case and folds the body into a digest', () => {
    const canonical = canonicalRequest(parts);
    expect(canonical.split('\n').slice(0, 4)).toEqual(['POST', '/api/v1/federation/operations', '1000', 'n1']);
    expect(canonical).not.toContain('"a":1');
  });

  it('verifies with the signer token and rejects any other token', () => {
    const signature = signRequest('token-a', parts);
    expect(verifyRequestSignature('token-a', parts, signature)).toBe(true);
    expect(verifyRequestSignature('token-b', parts, signature)).toBe(false);
  });

  it('rejects a changed body, path, time or nonce', () => {
    const signature = signRequest('token-a', parts);
    expect(verifyRequestSignature('token-a', { ...parts, body: '{"a":2}' }, signature)).toBe(false);
    expect(verifyRequestSignature('token-a', { ...parts, path: '/api/v1/federation/health' }, signature)).toBe(false);
    expect(verifyRequestSignature('token-a', { ...parts, timestamp: 1_001 }, signature)).toBe(false);
    expect(verifyRequestSignature('token-a', { ...parts, nonce: 'n2' }, signature)).toBe(false);
  });

  it('treats malformed signatures as a mismatch instead of throwing', () => {
    expect(verifyRequestSignature('token-a', parts, 'not-hex')).toBe(false);
    expect(verifyRequestSignature('token-a', parts, '')).toBe(false);
  });

  it('builds headers that verify on the other side, with a percent-encoded node name', () => {
    const headers = signatureHeaders('token-a', '自宅PC', { method: 'GET', path: '/x', body: '' }, 5_000, 'nonce-1');
    expect(headers[NODE_HEADER]).toBe(encodeURIComponent('自宅PC'));
    expect(headers[TIMESTAMP_HEADER]).toBe('5000');
    expect(headers[NONCE_HEADER]).toBe('nonce-1');
    expect(
      verifyRequestSignature('token-a', { method: 'GET', path: '/x', body: '', timestamp: 5_000, nonce: 'nonce-1' }, headers[SIGNATURE_HEADER]!),
    ).toBe(true);
  });
});
