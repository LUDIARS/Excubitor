/**
 * ポート衝突検知 API (`/api/v1/ports`)。
 * catalog 宣言 port の占有状況 + 重複宣言 + 現在の LISTEN 一覧を返す (req5)。
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { buildPortReport } from './ports.js';

function stateByCode(): Map<string, string> {
  const rows = db().all(sql`
    SELECT s.code AS code, si.state AS state
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
  `) as Array<{ code: string; state: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.code, r.state ?? 'unknown');
  return map;
}

export function buildPortsRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  app.get('/api/v1/ports', async (c) => {
    const report = await buildPortReport(getCatalog(), stateByCode());
    return c.json(report);
  });

  return app;
}
