/**
 * 新規サービス検出 API (`/api/v1/discovery`)。
 *
 * Ars ワークスペースの git repo を走査し、 catalog 未登録の候補 + clone 欠落を返す。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { discoverServices } from './scan.js';

export function buildDiscoveryRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  app.get('/api/v1/discovery', async (c) => {
    const result = await discoverServices(getCatalog());
    return c.json(result);
  });

  return app;
}
