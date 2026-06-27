/**
 * Federation API (`/api/v1/peers/*` + `/api/v1/federation/*`)。
 *
 * 2 つの面を持つ:
 *  1. ローカル管理 (loopback、 本ノードの UI が使う):
 *     - ピア CRUD (/api/v1/peers)
 *     - 集約ビュー (/api/v1/federation/services — local + 全 enabled ピア)
 *     - リモート操作プロキシ (/api/v1/peers/:id/services/:code/control|update)
 *  2. リモート公開 (他拠点ノードが Bearer token 付きで叩く):
 *     - GET  /api/v1/federation/node     本ノードのサマリ + サービス + host メトリクス
 *     - POST /api/v1/federation/control  本ノードの 1 サービスを操作
 *     - POST /api/v1/federation/update   本ノードの 1 サービスを更新
 *   リモート公開面は agent token (本ノード自身の token) で認証する。 ローカル管理面は
 *   loopback bind に依存する (既存 control API と同方針)。
 */

import os from 'node:os';
import { Hono } from 'hono';
import { z } from 'zod';
import { sql as drizzleSql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { verifyAgentToken, getOrCreateAgentToken } from '../secrets/agent-token.js';
import { controlService } from '../control/manager.js';
import { applyUpdate } from '../update/apply.js';
import { summarizeServices, type ServiceStateRow } from '../hub/router.js';
import {
  listPeers, getPeer, createPeer, updatePeer, deletePeer, markPeerResult, toView, type RemotePeer,
} from './store.js';
import { fetchNode, remoteControl, remoteUpdate } from './client.js';

const logger = createNamedLogger('excubitor.federation');

const CreatePeerSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  token: z.string().min(1),
  enabled: z.boolean().optional(),
});

const UpdatePeerSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  token: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const ControlSchema = z.object({
  code: z.string().min(1),
  action: z.enum(['start', 'stop', 'restart']),
});

const UpdateSchema = z.object({
  code: z.string().min(1),
  install: z.boolean().optional(),
  restart: z.boolean().optional(),
});

/** 本ノードの名前 (federation 上の識別子)。 env 優先、 既定 hostname。 */
export function localNodeName(): string {
  return process.env.EXCUBITOR_NODE_NAME?.trim() || os.hostname();
}

export interface NodeSnapshot {
  node: string;
  summary: ReturnType<typeof summarizeServices>;
  services: Array<{ code: string; name: string; state: string; port: number | null; git_branch: string | null }>;
  host: Record<string, unknown> | null;
}

/** 本ノードのスナップショット (リモート公開 + ローカル集約の self 部分で共用)。 */
export function localNodeSnapshot(): NodeSnapshot {
  const stateRows = db().all(drizzleSql`
    SELECT si.state AS state
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
  `) as Array<ServiceStateRow>;
  const errRows = db().all(
    drizzleSql`SELECT COUNT(*) AS n FROM error_tasks WHERE state = 'open'`,
  ) as Array<{ n: number }>;
  const summary = summarizeServices(stateRows, Number(errRows[0]?.n ?? 0));

  const svcRows = db().all(drizzleSql`
    SELECT s.code, s.name, si.state, si.port, si.git_branch
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
    ORDER BY s.code ASC
  `) as Array<Record<string, unknown>>;
  const services = svcRows.map((r) => ({
    code: r.code as string,
    name: r.name as string,
    state: (r.state as string | null) ?? 'unknown',
    port: (r.port as number | null) ?? null,
    git_branch: (r.git_branch as string | null) ?? null,
  }));

  const hostRows = db().all(drizzleSql`
    SELECT rss_bytes, cpu_pct, detail, sampled_at
    FROM memory_samples WHERE target_kind = 'host'
    ORDER BY sampled_at DESC LIMIT 1
  `) as Array<Record<string, unknown>>;
  let host: Record<string, unknown> | null = null;
  if (hostRows[0]) {
    let detail: Record<string, unknown> = {};
    try { detail = hostRows[0].detail ? JSON.parse(hostRows[0].detail as string) : {}; } catch { /* noop */ }
    host = {
      used_mem_bytes: hostRows[0].rss_bytes ?? null,
      cpu_pct: hostRows[0].cpu_pct ?? null,
      sampled_at: Number(hostRows[0].sampled_at),
      ...detail,
    };
  }

  return { node: localNodeName(), summary, services, host };
}

export function buildFederationRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  // ─── リモート公開面 (Bearer token 認証) ─────────────────────
  app.get('/api/v1/federation/node', (c) => {
    if (!verifyAgentToken(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
    return c.json(localNodeSnapshot());
  });

  app.post('/api/v1/federation/control', async (c) => {
    if (!verifyAgentToken(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
    const parsed = ControlSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const svc = getCatalog().services.find((s) => s.code === parsed.data.code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const actor = `federation:${c.req.header('x-excubitor-peer') ?? 'remote'}`;
    const result = await controlService(svc, parsed.data.action, actor);
    return c.json({ ok: result.ok, action: parsed.data.action, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr });
  });

  app.post('/api/v1/federation/update', async (c) => {
    if (!verifyAgentToken(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
    const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const svc = getCatalog().services.find((s) => s.code === parsed.data.code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const actor = `federation:${c.req.header('x-excubitor-peer') ?? 'remote'}`;
    const result = await applyUpdate(svc, actor, { install: parsed.data.install, restart: parsed.data.restart });
    return c.json(result, result.ok ? 200 : 400);
  });

  // ─── ローカル管理面 (peer CRUD) ─────────────────────────────

  // 本ノード自身の identity (federation 名 + agent token)。
  // ピア登録には相手ノードに「こちらの token」を貼る必要があるため、 UI が
  // コピー導線を出せるよう raw token を返す。 token は本ノードを操作できる
  // 機密なので、 これは loopback 管理面 (peer CRUD と同方針) でのみ提供する。
  app.get('/api/v1/federation/self', (c) =>
    c.json({ node: localNodeName(), token: getOrCreateAgentToken() }),
  );

  app.get('/api/v1/peers', (c) => c.json({ peers: listPeers().map(toView) }));

  app.post('/api/v1/peers', async (c) => {
    const parsed = CreatePeerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const peer = createPeer(parsed.data);
    logger.info({ id: peer.id, name: peer.name, base_url: peer.base_url }, 'peer added');
    return c.json({ ok: true, peer: toView(peer) }, 201);
  });

  app.patch('/api/v1/peers/:id', async (c) => {
    const parsed = UpdatePeerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const peer = updatePeer(c.req.param('id'), parsed.data);
    if (!peer) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true, peer: toView(peer) });
  });

  app.delete('/api/v1/peers/:id', (c) => {
    const ok = deletePeer(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  // ピア疎通テスト (node を 1 回引いて last_ok/last_error を更新)。
  app.post('/api/v1/peers/:id/test', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'not_found' }, 404);
    const res = await fetchNode(peer);
    markPeerResult(peer.id, res.ok, res.error);
    return c.json({ ok: res.ok, status: res.status, error: res.error, node: res.data?.node ?? null });
  });

  // ─── 集約ビュー: local + 全 enabled ピア ───────────────────
  app.get('/api/v1/federation/services', async (c) => {
    const self = localNodeSnapshot();
    const peers = listPeers().filter((p) => p.enabled);
    const remote = await Promise.all(
      peers.map(async (p) => {
        const res = await fetchNode(p);
        markPeerResult(p.id, res.ok, res.error);
        return {
          peer_id: p.id,
          name: p.name,
          base_url: p.base_url,
          ok: res.ok,
          error: res.error,
          node: res.data?.node ?? p.name,
          summary: res.data?.summary ?? null,
          services: res.data?.services ?? [],
          host: res.data?.host ?? null,
        };
      }),
    );
    return c.json({
      local: { peer_id: null, name: self.node, base_url: null, ok: true, error: null, ...self },
      peers: remote,
    });
  });

  // ─── リモート操作プロキシ ───────────────────────────────────
  app.post('/api/v1/peers/:id/services/:code/control', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { action?: 'start' | 'stop' | 'restart' };
    if (!body.action || !['start', 'stop', 'restart'].includes(body.action)) {
      return c.json({ error: 'invalid_action' }, 400);
    }
    const res = await remoteControl(peer, c.req.param('code'), body.action);
    markPeerResult(peer.id, res.ok, res.error);
    return c.json({ ok: res.ok, status: res.status, error: res.error, result: res.data }, res.ok ? 200 : 502);
  });

  app.post('/api/v1/peers/:id/services/:code/update', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { install?: boolean; restart?: boolean };
    const res = await remoteUpdate(peer, c.req.param('code'), body);
    markPeerResult(peer.id, res.ok, res.error);
    return c.json({ ok: res.ok, status: res.status, error: res.error, result: res.data }, res.ok ? 200 : 502);
  });

  return app;
}

// re-export for callers/tests
export type { RemotePeer };
