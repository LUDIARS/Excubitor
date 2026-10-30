import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ vault: vi.fn() }));
vi.mock('../vault/vault-inject.js', () => ({ resolveVaultEnv: mocks.vault }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ex-token-split-'));
  vi.stubEnv('EXCUBITOR_MASTER_KEY', 'split-test-master-key');
  vi.stubEnv('EXCUBITOR_AGENT_TOKEN', '');
  vi.stubEnv('EXCUBITOR_AGENT_TOKEN_PATH', join(dir, 'secret-agent.token'));
  vi.stubEnv('EXCUBITOR_MESH_TOKEN', '');
  vi.stubEnv('EXCUBITOR_MESH_TOKEN_PATH', join(dir, 'mesh.token'));
  vi.stubEnv('EXCUBITOR_SECRET_AGENT_LEGACY_TOKEN', '');
  writeFileSync(join(dir, 'secret-agent.token'), 'legacy-shared-token');
  vi.resetModules();
  mocks.vault.mockReset();
  mocks.vault.mockResolvedValue({ A: 'a' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT */
describe('service-scoped secret-agent tokens', () => {
  it('binds the token to one service code and rejects tampering', async () => {
    const { serviceAgentToken, verifyServiceAgentToken } = await import('./service-agent-token.js');
    const token = serviceAgentToken('actio');
    expect(token.startsWith('exsa1.actio.')).toBe(true);
    expect(verifyServiceAgentToken(token)).toBe('actio');
    expect(verifyServiceAgentToken(token.replace('exsa1.actio.', 'exsa1.memoria.'))).toBeNull();
    expect(verifyServiceAgentToken(serviceAgentToken('actio', 'another-site-key'))).toBeNull();
    expect(verifyServiceAgentToken('exsa1.actio')).toBeNull();
    expect(() => serviceAgentToken('../x')).toThrow();
  });

  it('authenticates service tokens and the legacy token only while compatibility is on', async () => {
    const { authenticateSecretAgent } = await import('./secret-agent-auth.js');
    const { serviceAgentToken } = await import('./service-agent-token.js');
    expect(authenticateSecretAgent(`Bearer ${serviceAgentToken('actio')}`)).toEqual({ kind: 'service', service: 'actio' });
    expect(authenticateSecretAgent('Bearer legacy-shared-token')).toEqual({ kind: 'legacy' });
    expect(authenticateSecretAgent('Bearer legacy-shared-token', { legacyAccepted: false })).toBeNull();
    expect(authenticateSecretAgent('Bearer wrong')).toBeNull();
    expect(authenticateSecretAgent(undefined)).toBeNull();
  });

  it('resolves only the service named by a service token', async () => {
    const { buildSecretAgentRouter } = await import('./agent-router.js');
    const { serviceAgentToken } = await import('./service-agent-token.js');
    const app = buildSecretAgentRouter(() => undefined);
    const resolve = (token: string, service: string) => app.request('/api/v1/secrets/resolve', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service }),
    });
    const actio = serviceAgentToken('actio');
    expect((await resolve(actio, 'memoria')).status).toBe(403);
    expect(mocks.vault).not.toHaveBeenCalled();
    expect((await resolve(actio, 'actio')).status).toBe(200);
    expect(mocks.vault).toHaveBeenCalledWith('actio');
    // Legacy compatibility keeps old callers working until the site switches it off.
    expect((await resolve('legacy-shared-token', 'memoria')).status).toBe(200);
    vi.stubEnv('EXCUBITOR_SECRET_AGENT_LEGACY_TOKEN', 'reject');
    expect((await resolve('legacy-shared-token', 'memoria')).status).toBe(401);
  });

  it('never accepts the federation mesh token at the secret-agent once the tokens differ', async () => {
    const { rotateMeshToken } = await import('../federation/mesh-token.js');
    const { authenticateSecretAgent } = await import('./secret-agent-auth.js');
    const mesh = rotateMeshToken();
    expect(mesh).not.toBe('legacy-shared-token');
    expect(authenticateSecretAgent(`Bearer ${mesh}`)).toBeNull();
  });

  it('does not treat an injected service token as the legacy shared token', async () => {
    const { serviceAgentToken } = await import('./service-agent-token.js');
    vi.stubEnv('EXCUBITOR_AGENT_TOKEN', serviceAgentToken('actio'));
    const { getOrCreateAgentToken } = await import('./agent-token.js');
    expect(getOrCreateAgentToken()).toBe('legacy-shared-token');
  });
});

/** @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT */
describe('federation mesh token', () => {
  it('starts from the legacy value so existing peer registrations keep working', async () => {
    const { getOrCreateMeshToken, verifyMeshToken } = await import('../federation/mesh-token.js');
    expect(getOrCreateMeshToken()).toBe('legacy-shared-token');
    expect(readFileSync(join(dir, 'mesh.token'), 'utf8')).toBe('legacy-shared-token');
    expect(verifyMeshToken('Bearer legacy-shared-token')).toBe(true);
  });

  it('rotates to a new value that is persisted and verified', async () => {
    const { rotateMeshToken, verifyMeshToken, getOrCreateMeshToken } = await import('../federation/mesh-token.js');
    const rotated = rotateMeshToken();
    expect(getOrCreateMeshToken()).toBe(rotated);
    expect(readFileSync(join(dir, 'mesh.token'), 'utf8')).toBe(rotated);
    expect(verifyMeshToken(`Bearer ${rotated}`)).toBe(true);
    expect(verifyMeshToken('Bearer legacy-shared-token')).toBe(false);
    expect(existsSync(join(dir, `mesh.token.${process.pid}.tmp`))).toBe(false);
  });
});
