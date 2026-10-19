import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { meshProofHeaders, verifyMeshProof, type MeshProof } from './proof.js';
import { keys, NOW } from './test-fixtures.js';

it('binds every request component and rejects another workload key', () => {
  const parts: MeshProof = { method: 'POST', path: '/vault?service=demo', body: '{}',
    timestamp: NOW, nonce: '0123456789abcdef', token: 'token-a', audience: 'hq/excubitor' };
  const headers = meshProofHeaders({ ...parts, subject: 'branch/excubitor', privateKey: keys.privateKey, now: NOW });
  const signature = headers['x-excubitor-signature']!;
  expect(verifyMeshProof({ publicKey: keys.publicKey, parts, signature })).toBe(true);
  for (const change of [{ method: 'GET' }, { path: '/vault?service=other' }, { body: '{"x":1}' },
    { timestamp: NOW + 1 }, { nonce: 'other-nonce' }, { token: 'token-b' }, { audience: 'other/excubitor' }]) {
    expect(verifyMeshProof({ publicKey: keys.publicKey, parts: { ...parts, ...change }, signature })).toBe(false);
  }
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  expect(verifyMeshProof({ publicKey: other, parts, signature })).toBe(false);
  expect(verifyMeshProof({ publicKey: keys.publicKey, parts, signature: signature + 'garbage' })).toBe(false);
});
