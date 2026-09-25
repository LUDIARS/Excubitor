import type { Catalog } from '../catalog/loader.js';
import type { FederationListenerStatus } from './listener.js';
import type { NodeHealthPayload } from './health-types.js';
import { localHealthPayload } from './node-health.js';
import { listPeers } from './store.js';
import { startPeriodicTask } from '../shared/periodic.js';
import { createNamedLogger } from '../shared/logger.js';
/** @implements SPEC-EX-HEALTH-CACHE-ONLY */
export function startFederationPayloadCache(getCatalog: () => Catalog, getListener: () => FederationListenerStatus) {
  let current: NodeHealthPayload | null = null;
  const logger = createNamedLogger('excubitor.federation.cache');
  const refresh = (): void => {
    listPeers(); // Refresh authentication material outside health request handling.
    current = localHealthPayload(getCatalog(), getListener());
  };
  // Publish before exposing the router: the first request must not race a timer.
  // Failure is observable as snapshot_pending; requests never collect on demand.
  try { refresh(); }
  catch { logger.warn('initial federation snapshot unavailable'); }
  const task = startPeriodicTask({
    run: async () => { refresh(); },
    intervalMs: () => 10_000,
    onError: () => logger.warn('federation snapshot refresh failed; retaining last snapshot'),
  });
  return { read: () => current, stop: task.stop };
}
