/** @implements SPEC-EX-DNS-FILTER */
/**
 * DNS フィルタの API。
 * - GET    /api/v1/dns-filter/status       : 待ち受けの状態・件数・規則の数
 * - GET    /api/v1/dns-filter/queries      : 直近の問い合わせ (?limit=1..1000&action=blocked|allowed|failed&name=部分一致)
 * - GET    /api/v1/dns-filter/rules        : API で足した拒否規則
 * - POST   /api/v1/dns-filter/rules        : { domain, reason, ttl_minutes? } (省略で期限なし)
 * - DELETE /api/v1/dns-filter/rules/:id    : 解除
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { QueryRecord } from './query-log.js';
import type { RuleEntry } from './rule-registry.js';
import type { DnsFilterHandle } from './runtime.js';

const AddSchema = z.object({
  domain: z.string().min(1).max(260),
  reason: z.string().trim().min(1).max(200),
  ttl_minutes: z.number().int().positive().optional(),
}).strict();

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIONS = new Set(['allowed', 'blocked', 'failed']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function ruleJson(entry: RuleEntry): Record<string, unknown> {
  return {
    id: entry.id,
    domain: entry.domain,
    reason: entry.reason,
    created_by: entry.createdBy,
    created_at: iso(entry.createdAtMs),
    expires_at: iso(entry.expiresAtMs),
  };
}

function queryJson(record: QueryRecord): Record<string, unknown> {
  return {
    at: iso(record.atMs),
    client: record.client,
    transport: record.transport,
    name: record.name,
    type: record.type,
    action: record.action,
    rule: record.rule,
    source: record.source,
    rcode: record.rcode,
    detail: record.detail,
    elapsed_ms: record.elapsedMs,
  };
}

export function buildDnsFilterRouter(handle: Pick<DnsFilterHandle, 'status' | 'queries' | 'rules'>): Hono {
  const app = new Hono();

  app.get('/api/v1/dns-filter/status', (c) => {
    const status = handle.status();
    return c.json({
      state: status.state,
      reason: status.reason,
      config_error: status.configError,
      listen: status.listen,
      upstream: status.upstream,
      counters: status.counters,
      in_flight: status.inFlight,
      rules: status.rules,
    });
  });

  app.get('/api/v1/dns-filter/queries', (c) => {
    const limitText = c.req.query('limit');
    const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return c.json({ error: `limit は 1〜${MAX_LIMIT}` }, 400);
    const action = c.req.query('action');
    if (action !== undefined && !ACTIONS.has(action)) return c.json({ error: 'action は allowed / blocked / failed' }, 400);
    const name = c.req.query('name')?.trim().toLowerCase();
    const filter = action || name
      ? (record: QueryRecord) => (!action || record.action === action) && (!name || record.name.includes(name))
      : undefined;
    return c.json({ queries: handle.queries(limit, filter).map(queryJson) });
  });

  app.get('/api/v1/dns-filter/rules', (c) => {
    const overview = handle.rules.overview();
    return c.json({ state: overview.state, reason: overview.reason, rules: overview.rules.map(ruleJson) });
  });

  app.post('/api/v1/dns-filter/rules', async (c) => {
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
    const result = await handle.rules.add({
      domain: parsed.data.domain,
      reason: parsed.data.reason,
      ttlMinutes: parsed.data.ttl_minutes,
      actor: c.req.header('x-excubitor-actor')?.slice(0, 100) ?? 'anonymous',
    });
    if (!result.ok) {
      return c.json({ error: result.error, ...(result.existing ? { existing: ruleJson(result.existing) } : {}) }, result.status);
    }
    return c.json({ rule: ruleJson(result.value) }, 201);
  });

  app.delete('/api/v1/dns-filter/rules/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) return c.json({ error: 'id は UUID' }, 400);
    const result = await handle.rules.remove(id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ rule: ruleJson(result.value) });
  });

  return app;
}
