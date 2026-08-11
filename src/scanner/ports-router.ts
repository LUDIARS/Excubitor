/**
 * ポート衝突検知 API (`/api/v1/ports`)。
 * catalog 宣言 port の占有状況 + 重複宣言 + 現在の LISTEN 一覧を返す (req5)。
 *
 * 実測とキャッシュは port-report-cache.ts が持つ (同じ一覧をサービス状態 API も使う)。
 */

import { Hono } from 'hono';
import type { PortReportProvider } from './port-report-cache.js';

export function buildPortsRouter(provider: PortReportProvider): Hono {
  const app = new Hono();
  app.get('/api/v1/ports', async (c) => c.json((await provider.snapshot()).report));
  return app;
}
