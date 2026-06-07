/**
 * secret-agent ルーター (`POST /api/v1/secrets/resolve`)。
 *
 * Excubitor を「常駐 secret-agent」として使うための唯一の値返却経路。
 * 各サービス (crawler 等) が起動時に自分の service code を投げ、 resolved secret を
 * **レスポンス (in-process)** で受け取る。 env にもファイルにも書かない。
 * 認証は loopback (server.ts が 127.0.0.1 bind) + agent token の二段。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { verifyAgentToken } from './agent-token.js';
import { resolveServiceSecrets } from './resolve.js';
import type { ServiceInfisical } from './config-store.js';

const logger = createNamedLogger('excubitor.secrets.agent');

const BodySchema = z.object({
  service: z.string().min(1),
  keys: z.array(z.string()).optional(),
});

type HttpStatus = 400 | 401 | 404 | 502 | 503;

const ERROR_STATUS: Record<string, HttpStatus> = {
  no_mapping: 404,
  no_identity: 503,
  fetch_failed: 502,
};

/**
 * @param getCatalogInfisical service code → catalog 由来の Infisical 設定 (config-store 上書きが無い場合の fallback)
 */
export function buildSecretAgentRouter(
  getCatalogInfisical: (code: string) => ServiceInfisical | undefined,
): Hono {
  const app = new Hono();

  app.post('/api/v1/secrets/resolve', async (c) => {
    if (!verifyAgentToken(c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    }
    const { service, keys } = parsed.data;
    const res = await resolveServiceSecrets(service, getCatalogInfisical(service), keys);
    if (!res.ok) {
      logger.warn({ service, code: res.code }, 'resolve failed');
      return c.json({ error: res.code, message: res.message }, ERROR_STATUS[res.code] ?? 502);
    }
    logger.info({ service, count: Object.keys(res.secrets).length }, 'resolved secrets');
    return c.json({
      secrets: res.secrets,
      project_id: res.projectId,
      environment: res.environment,
    });
  });

  return app;
}
