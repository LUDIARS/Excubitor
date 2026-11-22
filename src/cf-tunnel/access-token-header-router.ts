/**
 * CF ブローカーの Access アプリ「サービストークンを 1 つのヘッダで受ける」設定 API。トークンは Excubitor 内だけ。
 *   GET /api/v1/cf-access/apps/token-header?hostname=<host>
 *       → { app: {id, name, domain}, read_service_tokens_from_header }
 *   PUT /api/v1/cf-access/apps/token-header  { hostname, header: string|null, apply? }
 *       既定は計画のみ ({ plan: true, before, after })。apply: true で書き、before を返す。
 * 判断は access-token-header-service.ts。ここは資格情報と allowlist の解決と HTTP 変換だけ。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md 要求 11)
 */

import { Hono } from 'hono';
import { createNamedLogger } from '../shared/logger.js';
import { changeTokenHeader, readTokenHeaderState } from './access-token-header-service.js';
import { currentAllowlist, failureStatus } from './broker-support.js';
import { CloudflareAccessApi } from './cloudflare-access-api.js';
import { resolveCfCredentials } from './credentials.js';

const logger = createNamedLogger('excubitor.cf-tunnel.access-token-header-router');
const PATH = '/api/v1/cf-access/apps/token-header';

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function buildCfAccessTokenHeaderRouter(): Hono {
  const app = new Hono();

  app.get(PATH, async (c) => {
    const hostname = c.req.query('hostname');
    if (!hostname) return c.json({ error: 'bad_request', message: 'hostname は必須' }, 400);
    try {
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      return c.json(await readTokenHeaderState(access, currentAllowlist(), hostname));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access token header read failed');
      return c.json({ error: 'cf_access_token_header_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  app.put(PATH, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hostname?: unknown; header?: unknown; apply?: unknown } | null;
    if (!body || typeof body.hostname !== 'string' || !('header' in body)) {
      return c.json({ error: 'bad_request', message: 'hostname と header (ヘッダ名か null) は必須' }, 400);
    }
    try {
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      const result = await changeTokenHeader(access, currentAllowlist(), {
        hostname: body.hostname,
        header: body.header,
        apply: body.apply,
      });
      if (result.applied) {
        logger.info({ hostname: result.app.domain, appId: result.app.id, before: result.before, after: result.after }, 'cf-access token header updated');
      }
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access token header update failed');
      return c.json({ error: 'cf_access_token_header_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  return app;
}
