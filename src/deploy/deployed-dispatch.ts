import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.deployed_dispatch');

export interface ServiceDeployedInput {
  code: string;
  gitHash: string | null;
  version: string;
  startedAt: Date;
  restartCount: number;
}

export type ServiceDeploymentResult = 'unversioned' | 'initial' | 'unchanged' | 'dispatched' | 'failed';

/**
 * Persist the observed hash first, then best-effort notify Concordia only for
 * a transition. Persisting before the network call prevents restart loops
 * from producing duplicate deployment events after a transient failure.
 */
export async function dispatchServiceDeployment(input: ServiceDeployedInput): Promise<ServiceDeploymentResult> {
  if (!input.gitHash) return 'unversioned';
  const previous = db().get(sql`
    SELECT git_hash FROM service_deployments WHERE service_code = ${input.code}
  `) as { git_hash: string } | undefined;
  db().run(sql`
    INSERT INTO service_deployments (service_code, git_hash, updated_at)
    VALUES (${input.code}, ${input.gitHash}, unixepoch() * 1000)
    ON CONFLICT(service_code) DO UPDATE SET git_hash = excluded.git_hash, updated_at = excluded.updated_at
  `);
  if (!previous) return 'initial';
  if (previous.git_hash === input.gitHash) return 'unchanged';

  try {
    const response = await fetch(concordiaUrl('/v1/events/service-deployed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: input.code,
        previousHash: previous.git_hash,
        currentHash: input.gitHash,
        version: input.version,
        startedAt: input.startedAt.toISOString(),
        restartCount: input.restartCount,
      }),
      signal: AbortSignal.timeout(resolveTimeoutMs()),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return 'dispatched';
  } catch (err) {
    logger.warn({ code: input.code, err: (err as Error).message }, 'service deployment dispatch failed');
    return 'failed';
  }
}

function concordiaUrl(path: string): string {
  const base = process.env.EXCUBITOR_CONCORDIA_URL || 'http://127.0.0.1:11111';
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

function resolveTimeoutMs(): number {
  const raw = Number(process.env.EXCUBITOR_CONCORDIA_TIMEOUT_MS ?? '10000');
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}
