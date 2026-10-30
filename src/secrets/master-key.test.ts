import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson, decryptJson, type EncryptedBlob } from './crypto.js';

// DPAPI (powershell) を起こさず、 どの OS でも 0600 ファイルの KeyStore で検証する。
vi.mock('./master-key-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./master-key-store.js')>();
  return { ...actual, createMasterKeyStore: (dir: string) => actual.createMasterKeyStore(dir, 'linux') };
});

const legacySecret = `excubitor:${hostname()}:${userInfo().username}`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ex-master-key-'));
  vi.stubEnv('EXCUBITOR_MASTER_KEY', '');
  vi.stubEnv('EXCUBITOR_MASTER_KEY_DIR', dir);
  vi.stubEnv('EXCUBITOR_CONFIG_PATH', join(dir, 'config.enc'));
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** @implements SPEC-SECURITY-MASTER-KEY-STORE */
describe('master key store', () => {
  it('creates one random 32-byte key in the key store and reuses it', async () => {
    const { createMasterKeyStore, loadOrCreateMasterKey } = await import('./master-key-store.js');
    const store = createMasterKeyStore(dir);
    const first = loadOrCreateMasterKey(store);
    expect(first).toHaveLength(32);
    expect(loadOrCreateMasterKey(createMasterKeyStore(dir)).equals(first)).toBe(true);
    // A concurrent creator that loses the exclusive create adopts the winner's key.
    expect(store.createExclusive(Buffer.alloc(32, 1))).toBe(false);
    expect(loadOrCreateMasterKey(store).equals(first)).toBe(true);
  });

  it('no longer derives the key from hostname and user name', async () => {
    const { masterSecret } = await import('./master-key.js');
    expect(masterSecret()).not.toBe(legacySecret);
    expect(existsSync(join(dir, 'master.key'))).toBe(true);
  });

  it('opens legacy blobs with the old key and flags them for re-encryption', async () => {
    const { openWithMasterKeys, masterSecret } = await import('./master-key.js');
    expect(openWithMasterKeys(encryptJson('v', legacySecret))).toEqual({ value: 'v', legacy: true });
    expect(openWithMasterKeys(encryptJson('v', masterSecret()))).toEqual({ value: 'v', legacy: false });
    expect(() => openWithMasterKeys(encryptJson('v', 'unrelated'))).toThrow();
  });

  it('never tries the legacy key when the administrator pins EXCUBITOR_MASTER_KEY', async () => {
    vi.stubEnv('EXCUBITOR_MASTER_KEY', 'pinned');
    const { openWithMasterKeys, legacyMasterSecrets } = await import('./master-key.js');
    expect(legacyMasterSecrets()).toEqual([]);
    expect(() => openWithMasterKeys(encryptJson('v', legacySecret))).toThrow();
  });

  it('re-encrypts a legacy config.enc on read and keeps its contents', async () => {
    const path = join(dir, 'config.enc');
    writeFileSync(path, JSON.stringify(encryptJson({ settings: { domainRoot: 'example.org' } }, legacySecret)));
    const { getDomainRootOverride } = await import('./config-store.js');
    const { masterSecret } = await import('./master-key.js');
    expect(getDomainRootOverride()).toBe('.example.org'); // normalizeDomainRoot は先頭にドットを付ける
    const blob = JSON.parse(readFileSync(path, 'utf8')) as EncryptedBlob;
    expect(decryptJson(blob, masterSecret())).toEqual({ settings: { domainRoot: 'example.org' } });
    expect(() => decryptJson(blob, legacySecret)).toThrow();
  });

  it('flags legacy and plaintext peer secrets for resealing but never unreadable ones', async () => {
    const { openSecretDetailed, sealSecret } = await import('../federation/secret-box.js');
    expect(openSecretDetailed(JSON.stringify(encryptJson('peer-token', legacySecret)))).toEqual({ value: 'peer-token', needsReseal: true });
    expect(openSecretDetailed('plain-token')).toEqual({ value: 'plain-token', needsReseal: true });
    expect(openSecretDetailed(sealSecret('peer-token'))).toEqual({ value: 'peer-token', needsReseal: false });
    expect(openSecretDetailed(JSON.stringify(encryptJson('x', 'unrelated')))).toEqual({ value: null, needsReseal: false });
  });
});
