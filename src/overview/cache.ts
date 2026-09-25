import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { startPeriodicTask } from '../shared/periodic.js';
import { createNamedLogger } from '../shared/logger.js';
import { collectOverview } from './snapshot.js';
import type { ServiceOverview } from './model.js';
/** @implements SPEC-EX-HEALTH-CACHE-ONLY */
export function startOverviewCache(getCatalog: () => Catalog) {
  let snapshot: ServiceOverview | null = null;
  const logger = createNamedLogger('excubitor.overview');
  const task = startPeriodicTask({
    run: async () => { snapshot = await collectOverview(getCatalog(), Date.now()); },
    intervalMs: () => 10_000,
    onError: () => logger.warn('overview refresh failed; retaining last snapshot'),
  });
  const router = new Hono();
  router.get('/api/v1/overview', c => {
    c.header('Cache-Control', 'no-store');
    return snapshot ? c.json(snapshot) : c.json({ error: 'snapshot_pending' }, 503);
  });
  return { router, stop: task.stop };
}
