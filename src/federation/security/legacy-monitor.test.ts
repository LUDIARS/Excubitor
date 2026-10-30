import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireMutualPeer, type FederationEnv } from '../peer-auth.js';
import { signatureHeaders } from '../request-signature.js';
import { permitsMeshAction } from './grants.js';
import { describeMeshAuth, resolveMeshAuthPolicy, type LegacyMonitorMigration } from './legacy-monitor.js';
import { disableLegacyMonitorMigration, enableLegacyMonitorMigration, readLegacyMonitorMigration } from './legacy-monitor-store.js';
import { meshRequestHeaders } from './client-auth.js';
import * as configStore from './config.js';
import { NOW, securityConfig } from './test-fixtures.js';
import type { RemotePeer } from '../store.js';

const migration: LegacyMonitorMigration = { version: 1, mode: 'legacy-monitor', enabled_at: new Date(NOW).toISOString(), reason: 'Cr rollout' };
const notConfigured = (): never => { throw new Error('mesh_security_not_configured'); };

function migratingApp(enabled: boolean): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();
  app.use('*', requireMutualPeer({ now: () => NOW, config: notConfigured, migration: () => enabled ? migration : null,
    peers: () => [{ id: 'branch', name: 'Branch', enabled: true, token: 'old-shared-token' }],
    verifyBearer: header => header === 'Bearer local-token' }));
  app.all('*', c => {
    const caller = c.get('federationCaller');
    return c.json({ caller, monitor: permitsMeshAction({ caller, action: 'monitor', resource: 'node:hq/excubitor' }) });
  });
  return app;
}
function legacyHeaders(method: string, path: string, body = ''): Record<string, string> {
  return { authorization: 'Bearer local-token', ...signatureHeaders('old-shared-token', 'Branch', { method, path, body }, NOW) };
}

describe('legacy-monitor migration policy', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('applies only when the security file is absent and the switch is explicitly enabled', () => {
    expect(resolveMeshAuthPolicy({ loadConfig: notConfigured, loadMigration: () => migration }).kind).toBe('legacy-monitor-migration');
    expect(() => resolveMeshAuthPolicy({ loadConfig: notConfigured, loadMigration: () => null })).toThrow('mesh_security_not_configured');
    // A broken administrator file never degrades to the legacy fallback.
    expect(() => resolveMeshAuthPolicy({ loadConfig: () => { throw new SyntaxError('bad json'); }, loadMigration: () => migration })).toThrow('bad json');
    expect(resolveMeshAuthPolicy({ loadConfig: securityConfig, loadMigration: () => migration }).kind).toBe('configured');
  });

  it('keeps health/node at 200 without the new auth config while migration is enabled', async () => {
    for (const path of ['/api/v1/federation/health', '/api/v1/federation/node']) {
      const response = await migratingApp(true).request(path, { headers: legacyHeaders('GET', path) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ caller: { authMode: 'legacy-monitor' }, monitor: true });
    }
  });

  it('stays closed (503) without the explicit switch', async () => {
    const path = '/api/v1/federation/health';
    expect((await migratingApp(false).request(path, { headers: legacyHeaders('GET', path) })).status).toBe(503);
  });

  it('rejects update, deploy, bundle and Vault distribution during migration', async () => {
    const body = '{"target":{"kind":"service","code":"svc"},"action":"deploy"}';
    const cases: Array<[string, string, string]> = [
      ['POST', '/api/v1/federation/operations', body],
      ['POST', '/api/v1/federation/vault/env', '{"service":"svc"}'],
      ['GET', '/api/v1/federation/git/bundle?repo=LUDIARS%2FExcubitor', ''],
    ];
    for (const [method, path, payload] of cases) {
      const response = await migratingApp(true).request(path, { method, headers: legacyHeaders(method, path, payload), body: payload || undefined });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'legacy_monitor_only' });
    }
    // cr-v1 requests are never served by the migration switch.
    const path = '/api/v1/federation/operations';
    const crv1 = { ...legacyHeaders('POST', path, body), 'x-excubitor-auth': 'cr-v1' };
    expect((await migratingApp(true).request(path, { method: 'POST', headers: crv1, body })).status).toBe(503);
  });

  it('lets the outbound client only send monitor requests during migration', async () => {
    vi.spyOn(configStore, 'readMeshSecurityConfig').mockImplementation(notConfigured);
    const dir = mkdtempSync(join(tmpdir(), 'ex-legacy-'));
    try {
      const file = join(dir, 'mesh-legacy-monitor.json');
      vi.stubEnv('EXCUBITOR_MESH_LEGACY_MONITOR_FILE', file);
      vi.stubEnv('EXCUBITOR_MESH_TOKEN', 'local-mesh-token');
      const peer = { id: 'branch', name: 'Branch', base_url: 'https://branch.invalid', enabled: true, token: 'peer-token' } as RemotePeer;
      await expect(meshRequestHeaders(peer, 'GET', '/api/v1/federation/health', '', 'monitor', 'node:self')).rejects.toThrow('mesh_security_not_configured');
      enableLegacyMonitorMigration('Cr rollout', new Date(NOW), file);
      expect(readLegacyMonitorMigration(file)).toMatchObject({ mode: 'legacy-monitor', reason: 'Cr rollout' });
      expect((await meshRequestHeaders(peer, 'GET', '/api/v1/federation/health', '', 'monitor', 'node:self')).authorization).toBe('Bearer peer-token');
      for (const [method, path, action] of [['POST', '/api/v1/federation/vault/env', 'vault'], ['POST', '/api/v1/federation/operations', 'operation:deploy'],
        ['GET', '/api/v1/federation/git/bundle?repo=a%2Fb', 'bundle']] as const) {
        await expect(meshRequestHeaders(peer, method, path, '{}', action, 'service:svc')).rejects.toThrow('legacy_monitor_only');
      }
      disableLegacyMonitorMigration(file);
      expect(readLegacyMonitorMigration(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a warning for the startup log and the management UI', () => {
    expect(describeMeshAuth(() => ({ kind: 'legacy-monitor-migration', migration }))).toMatchObject({
      mode: 'legacy-monitor-migration', reason: 'Cr rollout', warning: expect.stringContaining('legacy-monitor'),
    });
    expect(describeMeshAuth(notConfigured)).toMatchObject({ mode: 'unconfigured', warning: expect.any(String) });
    expect(describeMeshAuth(() => ({ kind: 'configured', config: securityConfig() }))).toMatchObject({ mode: 'cr-v1', warning: null });
  });
});
