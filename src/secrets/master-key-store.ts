/**
 * master 鍵 (config.enc / remote_peers の暗号化鍵) を OS 側に保管する。同期版の KeyStore。
 *
 * Vault の DEK (vault/keystore.ts) と同じ保護をする:
 *   - win32: DPAPI (CurrentUser) で保護した blob を `master.key.dpapi` に置く。
 *   - それ以外: 0600 の `master.key`。
 * config-store / secret-box は同期 API なので、 ここも同期で読む (1 プロセス 1 回、 結果はキャッシュ)。
 *
 * backend と supervisor が同時に初回生成しても鍵が 2 本にならないよう、 書き込みは排他作成 (wx) にし、
 * 負けた側は勝った側の鍵を読み直す。
 *
 * @implements SPEC-SECURITY-MASTER-KEY-STORE
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DPAPI_INPUT_ENV, DPAPI_SCRIPT } from '../vault/keystore.js';

export const MASTER_KEY_BYTES = 32;

export interface SyncKeyStore {
  readonly kind: 'dpapi' | 'file';
  readonly path: string;
  load(): Buffer | null;
  /** 排他作成。 既にあれば false (呼び出し側が load し直す)。 */
  createExclusive(key: Buffer): boolean;
}

export function createMasterKeyStore(dir: string, platform: NodeJS.Platform = process.platform): SyncKeyStore {
  return platform === 'win32'
    ? new DpapiSyncKeyStore(join(dir, 'master.key.dpapi'))
    : new FileSyncKeyStore(join(dir, 'master.key'));
}

/** 保管済みの master 鍵を返す。 無ければ作る。 長さが違う鍵は使わず失敗する (黙って作り直さない)。 */
export function loadOrCreateMasterKey(store: SyncKeyStore): Buffer {
  const existing = store.load();
  if (existing) return checked(existing);
  if (store.createExclusive(randomBytes(MASTER_KEY_BYTES))) return checked(store.load());
  return checked(store.load()); // 同時生成に負けた: 勝った側の鍵を使う
}

function checked(key: Buffer | null): Buffer {
  if (!key || key.length !== MASTER_KEY_BYTES) throw new Error('master key has an unexpected length');
  return key;
}

function writeExclusive(path: string, content: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

class FileSyncKeyStore implements SyncKeyStore {
  readonly kind = 'file' as const;
  constructor(readonly path: string) {}

  load(): Buffer | null {
    if (!existsSync(this.path)) return null;
    return Buffer.from(readFileSync(this.path, 'utf8').trim(), 'base64');
  }

  createExclusive(key: Buffer): boolean {
    return writeExclusive(this.path, key.toString('base64'));
  }
}

class DpapiSyncKeyStore implements SyncKeyStore {
  readonly kind = 'dpapi' as const;
  constructor(readonly path: string) {}

  load(): Buffer | null {
    if (!existsSync(this.path)) return null;
    return Buffer.from(runDpapiSync('Unprotect', readFileSync(this.path, 'utf8').trim()), 'base64');
  }

  createExclusive(key: Buffer): boolean {
    return writeExclusive(this.path, runDpapiSync('Protect', key.toString('base64')));
  }
}

function runDpapiSync(op: 'Protect' | 'Unprotect', inputB64: string): string {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT(op)], {
      windowsHide: true, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, [DPAPI_INPUT_ENV]: inputB64 },
    }).trim();
  } catch {
    throw new Error(`DPAPI ${op} failed`);
  }
}
