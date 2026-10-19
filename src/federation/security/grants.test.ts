import { describe, expect, it } from 'vitest';
import type { FederationCaller } from '../peer-auth.js';
import { permitsMeshAction, selectVaultKeys, vaultKeysFor } from './grants.js';

const caller: FederationCaller = { peerId: 'b', peerName: 'B', claimedNode: null, authMode: 'cr-v1', expiresAt: Date.now() + 60_000,
  grants: [{ action: 'operation:deploy', resource: 'service:demo' }, { action: 'vault', resource: 'service:demo', keys: ['TOKEN'] }] };
describe('mesh resource grants', () => {
  it('separates target service, action, HQ config and AI spawn', () => {
    expect(permitsMeshAction({ caller, action: 'operation:deploy', resource: 'service:demo' })).toBe(true);
    for (const [action, resource] of [['operation:deploy', 'service:other'], ['hq-config', 'service:concordia'], ['ai-spawn', 'service:demo']]) {
      expect(permitsMeshAction({ caller, action: action!, resource: resource! })).toBe(false);
    }
  });
  it('denies missing auth, expired grants and legacy vault access', () => {
    for (const change of [{ authMode: undefined }, { expiresAt: 1 }, { authMode: 'legacy-monitor' as const }]) {
      expect(vaultKeysFor({ ...caller, ...change }, 'demo')).toEqual([]);
    }
  });
  it('filters values and missing names by the exact key grant', () => {
    const allowed = vaultKeysFor(caller, 'demo');
    expect(selectVaultKeys({ allowed, names: ['TOKEN', 'ADMIN_SECRET', 'TOKEN_SUFFIX'] })).toEqual(['TOKEN']);
    expect(vaultKeysFor(caller, 'other')).toEqual([]);
  });
});
