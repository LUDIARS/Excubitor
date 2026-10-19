import { generateKeyPairSync } from 'node:crypto';
import type { MeshSecurityConfig } from './config.js';
import type { WorkloadClaims } from './claims.js';

export const NOW = 1_790_000_000_000;
export const keys = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
export function securityConfig(): MeshSecurityConfig {
  return {
    version: 1, local: { subject: 'hq/excubitor', clientIdEnv: 'TEST_CLIENT', clientSecretEnv: 'TEST_SECRET', privateKeyEnv: 'TEST_KEY' },
    authority: { tokenUrl: 'https://cr.invalid/token', introspectionUrl: 'https://cr.invalid/introspect' },
    peers: { branch: { mode: 'cr-v1', subject: 'branch/excubitor', audience: 'branch/excubitor' } }, artifacts: {},
  };
}
export function workloadClaims(): WorkloadClaims {
  return { kind: 'workload', sub: 'branch/excubitor', aud: 'hq/excubitor',
    iat: new Date(NOW).toISOString(), exp: new Date(NOW + 60_000).toISOString(), jti: 'token-1',
    cnf: { public_key: keys.publicKey }, grants: [{ action: 'monitor', resource: 'node:hq/excubitor' }],
  };
}
