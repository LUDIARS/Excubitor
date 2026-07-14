import { describe, expect, it } from 'vitest';
import type { Catalog, Service } from '../catalog/loader.js';
import { runEmergencyAction } from './emergency.js';

describe('emergency service actions', () => {
  it('refuses to kill a port that is not declared by the target service', async () => {
    const service = {
      code: 'service-a',
      name: 'Service A',
      runtime: 'node',
      port: 32100,
    } as unknown as Service;
    const catalog = { services: [service] } as Catalog;

    await expect(runEmergencyAction(catalog, service, 'kill-port', undefined, 32101)).resolves.toMatchObject({
      ok: false,
      port: 32101,
      pids: [],
      stderr: 'port 32101 is not declared for service service-a',
    });
  });
});
