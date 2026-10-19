import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:c7cb7981 */
import augurContract_d357e39f from './claims.contract.js'; /* augur-inject:contract-predicate:f49d2616 */

export const WorkloadId = z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/).max(200);
export const GrantSchema = z.object({
  action: z.enum(['monitor', 'bundle', 'vault', 'hq-config',
    'operation:update', 'operation:restart', 'operation:deploy', 'operation:reflect',
    'operation:start', 'operation:stop', 'operation:bootstrap', 'operation:data-export', 'operation:data-import']),
  resource: z.string().min(1).max(400),
  keys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200)).max(500).optional(),
}).strict();
export type MeshGrant = z.infer<typeof GrantSchema>;

const ClaimsSchema = z.object({
  kind: z.literal('workload'), sub: WorkloadId, aud: WorkloadId,
  iat: z.string().datetime(), exp: z.string().datetime(), jti: z.string().min(1).max(200),
  cnf: z.object({ public_key: z.string().min(1).max(2048) }).strict(),
  grants: z.array(GrantSchema).max(200),
}).strict();
export type WorkloadClaims = z.infer<typeof ClaimsSchema>;

/** Claims come only from the configured, authenticated Cr introspection endpoint. */
export function validateWorkloadClaims(input: { claims: unknown; audience: string; subject: string; now: number }): WorkloadClaims {
  const claims = ClaimsSchema.parse(input.claims);
  const issued = Date.parse(claims.iat);
  const expires = Date.parse(claims.exp);
  if (!Number.isFinite(input.now) || claims.aud !== input.audience || claims.sub !== input.subject ||
      issued > input.now || expires <= input.now || expires <= issued || expires - issued > 60_000) {
    throw new Error('invalid_workload_claims');
  }
  if (createPublicKey(claims.cnf.public_key).asymmetricKeyType !== 'ed25519') throw new Error('invalid_workload_key');
  return claims;
}
// @ts-expect-error augur-inject
validateWorkloadClaims = contract(validateWorkloadClaims, { ...augurContract_d357e39f, contractId: 'C-14', mode: 'observe', sample: 1, where: 'src/federation/security/claims.ts:23', rule: 'contract-wrap', id: 'd357e39f' }); /* augur-inject:contract-wrap:d357e39f */
