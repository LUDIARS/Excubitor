import { afterEach, expect, it, vi } from 'vitest';
import { meshRequestHeaders } from './client-auth.js';
import * as configStore from './config.js';
import * as authority from './authority.js';
import { keys, securityConfig } from './test-fixtures.js';
import type { RemotePeer } from '../store.js';

const peer: RemotePeer = { id: 'branch', name: 'Branch', base_url: 'https://branch.invalid', enabled: true,
  token: 'old-shared-secret', cf_access_id: null, cf_access_secret: null, last_ok_at: null, last_error: null, created_at: 1, updated_at: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('uses local workload credentials and a recipient-specific Cr token', async () => {
  vi.spyOn(configStore, 'readMeshSecurityConfig').mockReturnValue(securityConfig());
  vi.stubEnv('TEST_KEY', keys.privateKey);
  const issue = vi.spyOn(authority, 'issueWorkloadToken').mockResolvedValue('short-lived-token');
  const headers = await meshRequestHeaders(peer, 'POST', '/api/v1/federation/vault/env', '{}', 'vault', 'service:demo');
  expect(issue).toHaveBeenCalledWith(expect.anything(), 'branch/excubitor', 'vault', 'service:demo');
  expect(headers.authorization).toBe('Bearer short-lived-token');
  expect(JSON.stringify(headers)).not.toContain('old-shared-secret');
});
it('does not fall back to old credentials on Cr failure or plaintext transport', async () => {
  vi.spyOn(configStore, 'readMeshSecurityConfig').mockReturnValue(securityConfig());
  const issue = vi.spyOn(authority, 'issueWorkloadToken').mockRejectedValue(new Error('revoked'));
  await expect(meshRequestHeaders(peer, 'GET', '/api/v1/federation/health', '', 'monitor', 'node:self')).rejects.toThrow('revoked');
  expect(issue).toHaveBeenCalledTimes(1);
  await expect(meshRequestHeaders({ ...peer, base_url: 'http://branch.invalid' }, 'GET', '/api/v1/federation/health', '', 'monitor', 'node:self')).rejects.toThrow('mesh_https_required');
  expect(issue).toHaveBeenCalledTimes(1);
});
it('denies privileged actions for legacy-monitor and unconfigured peers', async () => {
  const config = securityConfig();
  config.peers.branch = { mode: 'legacy-monitor' };
  vi.spyOn(configStore, 'readMeshSecurityConfig').mockReturnValue(config);
  await expect(meshRequestHeaders(peer, 'POST', '/api/v1/federation/vault/env', '{}', 'vault', 'service:demo')).rejects.toThrow('legacy_monitor_only');
  delete config.peers.branch;
  await expect(meshRequestHeaders(peer, 'GET', '/api/v1/federation/health', '', 'monitor', 'node:self')).rejects.toThrow('peer_auth_not_configured');
});
