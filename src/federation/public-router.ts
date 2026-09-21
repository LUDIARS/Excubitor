/**
 * 他拠点に公開する federation API (すべて agent token の Bearer 認証)。
 *
 *   GET  /api/v1/federation/health   担保サービス + キャッシュ済み死活 + 自拠点から見たつながり
 *   GET  /api/v1/federation/node     サマリ + サービス一覧 + host メトリクス (旧形式)
 *   POST /api/v1/federation/control  本拠点の 1 サービスを start / stop / restart
 *   POST /api/v1/federation/update   本拠点の 1 サービスを更新
 *
 * このルーターだけが拠点間リスナー (listener.ts、 メッシュ側アドレス) に載る。 ピア管理や
 * 設定などの管理面は載せない。 loopback の本体 (17332) にも同じルーターを載せる。
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Catalog } from '../catalog/loader.js';
import { verifyAgentToken } from '../secrets/agent-token.js';
import { controlServiceViaLocalTool } from '../local-control/service-adapter.js';
import { applyUpdate } from '../update/apply.js';
import { localNodeSnapshot } from './node-snapshot.js';
import { localHealthPayload } from './node-health.js';

/** @implements SPEC-FEDERATION-MESH */

const ControlSchema = z.object({
  code: z.string().min(1),
  action: z.enum(['start', 'stop', 'restart']),
});

const UpdateSchema = z.object({
  code: z.string().min(1),
  install: z.boolean().optional(),
  restart: z.boolean().optional(),
});

/** 監査ログに残す呼び出し元 (client.ts が percent-encode して名乗る)。 */
function remoteActor(header: string | undefined): string {
  if (!header) return 'federation:remote';
  try {
    return `federation:${decodeURIComponent(header).slice(0, 100)}`;
  } catch {
    // 壊れた percent-encoding は名乗りとして信用せず、 生の値を短く残す。
    return `federation:${header.slice(0, 100)}`;
  }
}

/**
 * agent token 必須。 ルート単位で付ける: このルーターは本体 (17332) にも route() で載るので、
 * `/api/v1/federation/*` 全体に掛けると同じ prefix の管理面 (loopback 用) まで塞いでしまう。
 */
const requireAgentToken: MiddlewareHandler = async (c, next) => {
  if (!verifyAgentToken(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
  await next();
};

export function buildFederationPublicRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  app.get('/api/v1/federation/health', requireAgentToken, (c) => c.json(localHealthPayload(getCatalog())));

  app.get('/api/v1/federation/node', requireAgentToken, (c) => c.json(localNodeSnapshot()));

  app.post('/api/v1/federation/control', requireAgentToken, async (c) => {
    const parsed = ControlSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const svc = getCatalog().services.find((s) => s.code === parsed.data.code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const actor = remoteActor(c.req.header('x-excubitor-peer'));
    const result = await controlServiceViaLocalTool(svc, parsed.data.action, actor);
    const status: 200 | 502 | 503 = result.ok
      ? 200
      : result.local_control_error === 'unavailable'
        ? 503
        : 502;
    return c.json({
      ok: result.ok,
      error: result.ok
        ? null
        : result.local_control_error === 'unavailable'
          ? 'local_control_unavailable'
          : 'control_failed',
      action: parsed.data.action,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      command: result.command,
      cli: `npm run ctl -- service ${svc.code} ${parsed.data.action} --json`,
    }, status);
  });

  app.post('/api/v1/federation/update', requireAgentToken, async (c) => {
    const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const svc = getCatalog().services.find((s) => s.code === parsed.data.code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const actor = remoteActor(c.req.header('x-excubitor-peer'));
    const result = await applyUpdate(svc, actor, { install: parsed.data.install, restart: parsed.data.restart });
    return c.json(result, result.ok ? 200 : 400);
  });

  return app;
}
