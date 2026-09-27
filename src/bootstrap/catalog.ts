import { resolve } from 'node:path';
import { loadCatalog, type Service } from '../catalog/loader.js';
import { requestLocalControl } from '../local-control/client.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export function bootstrapService(code: string, root: string, repository: string): Service {
  const service = loadCatalog().services.find(s => s.code === code);
  if (!service || service.disabled || service.repo !== repository || !service.cwd || resolve(service.cwd) !== resolve(root)) {
    throw new Error('Service catalog must declare matching code, repository and checkout cwd');
  }
  if (service.autostart) throw new Error('Bootstrap requires autostart=false until setup and import are complete');
  return service;
}

export async function requireStopped(code: string, actor: string): Promise<void> {
  const response = await requestLocalControl({ target: { kind: 'service', code }, action: 'status', actor });
  if (!response.ok || response.payload?.kind !== 'service-status' || response.payload.running !== false || response.payload.state !== 'stopped') {
    throw new Error('Service must be confirmed stopped before setup or data migration');
  }
}
