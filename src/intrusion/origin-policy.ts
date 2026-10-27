import type { Catalog } from '../catalog/loader.js';
import type { IntrusionConfig } from './config.js';
import { privateHttpOriginPort } from './origin.js';

/** Catalog defaults stay strict; only proven existing routes can use exceptional origins. */
export function validateOriginTargets(catalog: Catalog, config: IntrusionConfig, gatewayPort: number): Set<string> {
  const self = catalog.services.find(service => service.code === 'excubitor');
  const forbidden = new Set([gatewayPort, ...self?.ports?.filter(p => p.port !== self.port).map(p => p.port) ?? []]);
  const management = new Set<string>();
  for (const route of config.routes) {
    const port = privateHttpOriginPort(route.origin);
    if (port !== null && forbidden.has(port)) throw new Error('gateway/federation origin is forbidden');
    if (port === self?.port) {
      if (route.service !== 'excubitor' || new URL(route.origin).hostname !== '127.0.0.1' || !route.adoptExisting || !route.routeKey) {
        throw new Error('management origin requires explicit existing-route adoption');
      }
      management.add(route.routeKey);
    } else if (!route.adoptExisting) {
      const service = catalog.services.find(entry => entry.code === route.service);
      if (!service || port === null || ![service.port, ...service.ports?.map(entry => entry.port) ?? []].includes(port)) {
        throw new Error('origin must match its catalog service');
      }
    }
  }
  return management;
}
