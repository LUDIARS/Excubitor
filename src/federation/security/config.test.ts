import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localPrivateKey, MeshSecuritySchema } from './config.js';
import { securityConfig } from './test-fixtures.js';

it('keeps Cc recipient separate from the Ex peer identity', () => {
  const config = securityConfig();
  expect(MeshSecuritySchema.parse({ ...config, concordia: { audience: 'hq/concordia' } }).concordia)
    .toEqual({ audience: 'hq/concordia' });
  expect(MeshSecuritySchema.parse(config).concordia).toBeUndefined();
});

it('rejects Ex audiences, wildcard recipients and self-supplied credentials in the Cc recipient', () => {
  for (const concordia of [
    { audience: 'hq/excubitor' }, { audience: '*/concordia' },
    { audience: 'hq/concordia', clientSecret: 'not-accepted' },
  ]) {
    expect(MeshSecuritySchema.safeParse({ ...securityConfig(), concordia }).success).toBe(false);
  }
});

describe('local private key source', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ex-mesh-key-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const withFile = (file: unknown) => {
    const config = securityConfig();
    const { privateKeyEnv: _env, ...local } = config.local;
    return { ...config, local: { ...local, privateKeyFile: file } };
  };

  it('requires exactly one of privateKeyEnv or privateKeyFile', () => {
    const config = securityConfig();
    const { privateKeyEnv: _env, ...local } = config.local;
    expect(MeshSecuritySchema.safeParse({ ...config, local }).success).toBe(false);
    expect(MeshSecuritySchema.safeParse({ ...config, local: { ...config.local, privateKeyFile: join(dir, 'k.pem') } }).success).toBe(false);
    expect(MeshSecuritySchema.safeParse(withFile('relative/key.pem')).success).toBe(false);
    expect(MeshSecuritySchema.safeParse(withFile(join(dir, 'k.pem'))).success).toBe(true);
  });

  it('reads a multi-line PEM from an owner-only file', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const file = join(dir, 'key.pem');
    writeFileSync(file, pem, { mode: 0o600 });
    expect(localPrivateKey(MeshSecuritySchema.parse(withFile(file)))).toBe(pem);
  });

  it.skipIf(process.platform === 'win32')('rejects a key file readable by group or others', () => {
    const file = join(dir, 'key.pem');
    writeFileSync(file, 'pem', { mode: 0o600 });
    chmodSync(file, 0o644);
    expect(() => localPrivateKey(MeshSecuritySchema.parse(withFile(file)))).toThrow('mesh_private_key_file_permissions');
  });

  it('treats a missing or empty key file as not configured', () => {
    expect(() => localPrivateKey(MeshSecuritySchema.parse(withFile(join(dir, 'none.pem'))))).toThrow('mesh_credential_not_configured');
    const empty = join(dir, 'empty.pem');
    writeFileSync(empty, '\n', { mode: 0o600 });
    expect(() => localPrivateKey(MeshSecuritySchema.parse(withFile(empty)))).toThrow('mesh_credential_not_configured');
  });

  it('keeps the env source and injected credential reader', () => {
    expect(localPrivateKey(securityConfig(), name => `value-of-${name}`)).toBe('value-of-TEST_KEY');
  });
});
