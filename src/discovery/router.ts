/**
 * 新規サービス検出 + スキャン自動カタログ API (`/api/v1/discovery`)。
 *
 * - GET  /api/v1/discovery      : Ars の git repo を走査し catalog 未登録候補 + clone 欠落を返す。
 * - POST /api/v1/discovery/scan : 未登録 repo を解析し、 実行可能なものを services.auto.yaml に
 *   自動生成 (port も自動検出)。 書き込み後に catalog を再読込して即反映する。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { discoverServices } from './scan.js';
import { runScan } from '../catalog/auto-catalog.js';

export function buildDiscoveryRouter(
  getCatalog: () => Catalog,
  reloadCatalog: () => Promise<number>,
): Hono {
  const app = new Hono();

  app.get('/api/v1/discovery', async (c) => {
    const result = await discoverServices(getCatalog());
    return c.json(result);
  });

  app.post('/api/v1/discovery/scan', async (c) => {
    const result = await runScan(getCatalog());
    // 生成エントリを即座に catalog へ反映 (再読込)。
    const total = await reloadCatalog();
    return c.json({ ...result, catalog_total: total });
  });

  return app;
}
