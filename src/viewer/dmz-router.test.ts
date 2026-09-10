import { describe, expect, it } from 'vitest';
import { buildDmzRouter } from './dmz-router.js';
import type { ViewerDirectory } from './manifest.js';

const directory: ViewerDirectory = { entries: () => [], target: () => null };

describe('DMZ HTTP surface', () => {
  it('does not expose management API, secrets or MCP for any common method', async () => {
    const app = buildDmzRouter(directory);
    for (const path of ['/api/v1/config/infisical', '/api/v1/secrets/resolve',
      '/api/v1/services/example/control', '/api/v1/excubitor/control', '/mcp']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect((await app.request(path, { method })).status).toBe(404);
      }
    }
  });

  it('rejects unpublished services instead of proxying a browser-supplied target', async () => {
    const app = buildDmzRouter(directory);
    expect((await app.request('/viewer/apps/unpublished/')).status).toBe(404);
  });

  it('returns unavailable for expired directory including Villa, without reading documents', async () => {
    const app = buildDmzRouter({
      entries: () => { throw new Error('expired'); },
      target: () => { throw new Error('expired'); },
    });
    for (const path of ['/health', '/api/v1/viewer/services', '/viewer/apps/villa/', '/viewer/apps/example/']) {
      expect((await app.request(path)).status).toBe(503);
    }
  });
});
