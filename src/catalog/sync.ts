import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { services as servicesTable } from '../db/schema.js';
import { type Catalog, type Service } from './loader.js';

/**
 * catalog.yaml の内容を services テーブルに upsert する。
 * - 既存 (code 一致) は catalog_snapshot を更新
 * - 新規は INSERT
 * - catalog から削除されたサービスは is_active=false にする (CLAUDE.md DB 規約に従い物理削除しない)
 */
export async function syncCatalog(catalog: Catalog): Promise<{
  upserted: number;
  deactivated: number;
}> {
  const codes = catalog.services.map((s) => s.code);

  let upserted = 0;
  for (const svc of catalog.services) {
    const snapshot = svcToSnapshot(svc);
    await db.execute(sql`
      INSERT INTO services (code, name, catalog_snapshot, is_active, updated_at)
      VALUES (${svc.code}, ${svc.name}, ${JSON.stringify(snapshot)}::jsonb, TRUE, now())
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        catalog_snapshot = EXCLUDED.catalog_snapshot,
        is_active = TRUE,
        updated_at = now()
    `);
    upserted++;
  }

  // catalog から消えたサービスは soft delete
  let deactivated = 0;
  if (codes.length > 0) {
    const placeholders = codes.map((c) => sql`${c}`);
    const result = await db.execute(sql`
      UPDATE services
      SET is_active = FALSE, updated_at = now()
      WHERE is_active = TRUE
        AND code NOT IN (${sql.join(placeholders, sql`, `)})
      RETURNING id
    `);
    deactivated = (result as unknown as { length: number }).length ?? 0;
  }

  return { upserted, deactivated };
}

function svcToSnapshot(svc: Service) {
  // catalog 内容をそのまま JSON にする (loader で zod 検証済み)
  return svc;
}
