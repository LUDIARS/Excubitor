/**
 * secret-agent ルーター (`POST /api/v1/secrets/resolve`)。
 *
 * Excubitor を「常駐 secret-agent」として使うための唯一の値返却経路。
 * 各サービス (crawler 等) が起動時に自分の service code を投げ、 resolved secret を
 * **レスポンス (in-process)** で受け取る。 env にもファイルにも書かない。
 * 認証は loopback (server.ts が 127.0.0.1 bind) + agent token の二段。
 * token はサービスごと (token のサービスしか resolve できない)。 旧共有 token は移行期間だけ受ける
 * (secret-agent-auth.ts、 spec/feature/secret-agent.md)。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { authenticateSecretAgent, callerMayResolve, type SecretAgentCaller } from './secret-agent-auth.js';
import { resolveServiceSecrets } from './resolve.js';
import type { ServiceInfisical } from './config-store.js';

const logger = createNamedLogger('excubitor.secrets.agent');

const BodySchema = z.object({
  service: z.string().min(1),
  keys: z.array(z.string()).optional(),
});

type HttpStatus = 400 | 401 | 403 | 404 | 502;

const legacyWarned = new Set<string>();

function warnLegacyCaller(service: string): void {
  if (legacyWarned.has(service)) return;
  legacyWarned.add(service);
  logger.warn({ service }, 'secret-agent resolved with the legacy shared token; switch the caller to its service token');
}

const ERROR_STATUS: Record<string, HttpStatus> = {
  no_mapping: 404,
  keys_not_bound: 403,
  fetch_failed: 502,
};

/**
 * Legacy callback is retained for source compatibility but never consulted.
 */
export function buildSecretAgentRouter(
  _getCatalogInfisical: (code: string) => ServiceInfisical | undefined,
): Hono {
  const app = new Hono();

  app.post('/api/v1/secrets/resolve', async (c) => {
    const caller: SecretAgentCaller | null = authenticateSecretAgent(c.req.header('authorization'));
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    }
    const { service, keys } = parsed.data;
    if (!callerMayResolve(caller, service)) {
      logger.warn({ service, caller: caller.kind === 'service' ? caller.service : null }, 'secret-agent service mismatch');
      return c.json({ error: 'service_mismatch' }, 403);
    }
    if (caller.kind === 'legacy') warnLegacyCaller(service);
    const res = await resolveServiceSecrets(service, undefined, keys);
    if (!res.ok) {
      logger.warn({ service, code: res.code }, 'resolve failed');
      return c.json({ error: res.code, message: res.message }, ERROR_STATUS[res.code] ?? 502);
    }
    logger.info({ service, count: Object.keys(res.secrets).length }, 'resolved secrets');
    return c.json({
      secrets: res.secrets,
      project_id: res.projectId,
      environment: res.environment,
      source: 'vault',
    });
  });

  return app;
}
