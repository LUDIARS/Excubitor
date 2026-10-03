/** Resolve Infisical values only for the explicit, one-time Vault import API. */
import { resolveServiceInfisical, type ServiceInfisical } from '../secrets/config-store.js';
import { fetchProjectSecrets, readIdentity, toEnvMap } from '../secrets/infisical.js';

export type InfisicalImportResult =
  | { ok: true; secrets: Record<string, string>; projectId: string; environment: string }
  | { ok: false; code: 'no_mapping' | 'no_identity' | 'fetch_failed'; message: string };

export async function resolveInfisicalForImport(
  code: string,
  catalogInfisical?: ServiceInfisical,
): Promise<InfisicalImportResult> {
  const mapping = resolveServiceInfisical(code, catalogInfisical);
  if (!mapping) return { ok: false, code: 'no_mapping', message: `service ${code} has no Infisical mapping` };

  const identity = readIdentity();
  if (!identity) {
    return { ok: false, code: 'no_identity', message: 'Excubitor has no machine identity (INFISICAL_SITE_URL / CLIENT_ID / CLIENT_SECRET)' };
  }

  try {
    const secrets = await fetchProjectSecrets(identity, mapping.project_id, mapping.environment);
    return {
      ok: true,
      secrets: toEnvMap(secrets, { prefix: mapping.prefix, include: mapping.include, exclude: mapping.exclude }),
      projectId: mapping.project_id,
      environment: mapping.environment,
    };
  } catch (error) {
    return { ok: false, code: 'fetch_failed', message: (error as Error).message };
  }
}
