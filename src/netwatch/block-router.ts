/** @implements SPEC-EX-NETWATCH */
/**
 * 遮断 API (`/api/v1/netwatch/blocks`)。 人が登録した遮断を Windows ファイアウォールへ反映するための
 * 希望状態を書き換える。 反映は管理者権限の同期タスクが行い、 ここでは反映状況を返すだけ。
 *
 * - GET    /api/v1/netwatch/blocks      : 遮断の一覧と同期タスクの状態
 * - POST   /api/v1/netwatch/blocks      : { kind: address|program, value, reason, ttl_minutes? }
 * - DELETE /api/v1/netwatch/blocks/:id  : 解除
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { BlockEntry } from './block-registry.js';
import type { BlockService, BlockView } from './block-service.js';
import type { SyncStatus } from './firewall-sync-status.js';

const AddSchema = z.object({
  kind: z.enum(['address', 'program']),
  value: z.string().min(1).max(512),
  reason: z.string().trim().min(1).max(200),
  ttl_minutes: z.number().int().positive().optional(),
}).strict();

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function entryJson(entry: BlockEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    value: entry.value,
    reason: entry.reason,
    created_by: entry.createdBy,
    created_at: iso(entry.createdAtMs),
    expires_at: iso(entry.expiresAtMs),
  };
}

function viewJson(view: BlockView): Record<string, unknown> {
  return { ...entryJson(view), enforcement: view.enforcement, enforcement_reason: view.enforcementReason };
}

function syncJson(sync: SyncStatus | null): Record<string, unknown> | null {
  if (!sync) return null;
  return { state: sync.state, reason: sync.reason, synced_at: iso(sync.syncedAtMs) };
}

export function buildBlockRouter(service: BlockService): Hono {
  const app = new Hono();

  app.get('/api/v1/netwatch/blocks', (c) => {
    const overview = service.overview();
    return c.json({
      state: overview.state,
      reason: overview.reason,
      sync: syncJson(overview.sync),
      blocks: overview.blocks.map(viewJson),
    });
  });

  app.post('/api/v1/netwatch/blocks', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON の本文が要る' }, 400);
    }
    const parsed = AddSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`).join('; ') }, 400);
    }
    const result = await service.add({
      kind: parsed.data.kind,
      value: parsed.data.value,
      reason: parsed.data.reason,
      ttlMinutes: parsed.data.ttl_minutes,
      actor: c.req.header('x-excubitor-actor')?.slice(0, 100) ?? 'anonymous',
    });
    if (!result.ok) {
      return c.json({ error: result.error, ...(result.existing ? { existing: entryJson(result.existing) } : {}) }, result.status);
    }
    return c.json({ block: entryJson(result.value) }, 201);
  });

  app.delete('/api/v1/netwatch/blocks/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: 'id は UUID' }, 400);
    const result = await service.remove(id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ block: entryJson(result.value) });
  });

  return app;
}
