import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services as servicesTable } from '../db/schema.js';
import { type Catalog, type Service } from './loader.js';

/**
 * catalog.yaml の冁E��めEservices チE�Eブルに upsert する、E
 * - 既孁E(code 一致) は catalog_snapshot を更新
 * - 新規�E INSERT
 * - catalog から削除されたサービスは is_active=false にする (CLAUDE.md DB 規紁E��従い物琁E��除しなぁE
 */
export async function syncCatalog(catalog: Catalog): Promise<{
  upserted: number;
  deactivated: number;
}> {
  const codes = catalog.services.map((s) => s.code);

  // 過去 (id 生�E漏れバグ) で NULL id のまま残った行をまず除去.
  // service_instances は FK で繋がってぁE��ので先に消す.
  db().run(sql`DELETE FROM service_instances WHERE service_id IS NULL OR service_id IN (SELECT id FROM services WHERE id IS NULL)`);
  db().run(sql`DELETE FROM services WHERE id IS NULL`);

  let upserted = 0;
  for (const svc of catalog.services) {
    const snapshot = svcToSnapshot(svc);
    const newId = randomUUID();
    db().run(sql`
      INSERT INTO services (id, code, name, catalog_snapshot, is_active, created_at, updated_at)
      VALUES (${newId}, ${svc.code}, ${svc.name}, ${JSON.stringify(snapshot)}, 1, unixepoch() * 1000, unixepoch() * 1000)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        catalog_snapshot = EXCLUDED.catalog_snapshot,
        is_active = 1,
        updated_at = unixepoch() * 1000
    `);
    upserted++;
  }

  // catalog から消えたサービスは soft delete
  let deactivated = 0;
  if (codes.length > 0) {
    const placeholders = codes.map((c) => sql`${c}`);
    const result = db().all(sql`
      UPDATE services
      SET is_active = 0, updated_at = unixepoch() * 1000
      WHERE is_active = 1
        AND code NOT IN (${sql.join(placeholders, sql`, `)})
      RETURNING id
    `);
    deactivated = (result as unknown as { length: number }).length ?? 0;
  }

  return { upserted, deactivated };
}

function svcToSnapshot(svc: Service) {
  // catalog 冁E��をそのまま JSON にする (loader で zod 検証済み)
  return svc;
}


