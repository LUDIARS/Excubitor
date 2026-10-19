import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { WorkloadId } from './claims.js';

const HttpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
}, 'HTTPS endpoint without embedded credentials, query or fragment required');
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const PeerPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('disabled') }).strict(),
  z.object({ mode: z.literal('legacy-monitor') }).strict(),
  z.object({ mode: z.literal('cr-v1'), subject: WorkloadId, audience: WorkloadId }).strict(),
]);
export const MeshSecuritySchema = z.object({
  version: z.literal(1),
  local: z.object({
    subject: WorkloadId,
    clientIdEnv: EnvName, clientSecretEnv: EnvName, privateKeyEnv: EnvName,
  }).strict(),
  authority: z.object({ tokenUrl: HttpsUrl, introspectionUrl: HttpsUrl }).strict(),
  // Recipient for local Ex -> Cc provisioning; never infer it from an Ex peer.
  concordia: z.object({ audience: WorkloadId.refine(value => value.endsWith('/concordia')) }).strict().optional(),
  peers: z.record(PeerPolicy),
  artifacts: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  for (const policy of Object.values(value.peers)) {
    if (policy.mode !== 'cr-v1') continue;
    if (identities.has(policy.subject) || policy.subject === value.local.subject || policy.subject !== policy.audience) {
      context.addIssue({ code: 'custom', message: 'peer workload identity must be unique and recipient must match' });
    }
    identities.add(policy.subject);
  }
});
export type MeshSecurityConfig = z.infer<typeof MeshSecuritySchema>;

/** Read on each request: administrator policy removal takes effect without restart. */
export function readMeshSecurityConfig(): MeshSecurityConfig {
  const path = process.env.EXCUBITOR_MESH_SECURITY_FILE;
  if (!path) throw new Error('mesh_security_not_configured');
  return MeshSecuritySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function requiredCredential(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('mesh_credential_not_configured');
  return value;
}
