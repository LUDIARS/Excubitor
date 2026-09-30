/**
 * Vault のデータ鍵 (DEK) を OS 側に保管する。
 *
 * - win32: DPAPI (CurrentUser) で保護した blob を `vault.key.dpapi` に置く。
 *   同じ Windows ユーザでしか復号できず、ファイルだけ持ち出しても使えない。
 * - それ以外: 0600 の `vault.key` (supervisor は LaunchDaemon / systemd でログイン無しに動くので、
 *   ログインで開く Keychain / libsecret は使えない)。
 *
 * 「AI が読めない」は保証しない (同じ OS ユーザの権限で復号できる)。2026-09-30 neco 判断で許容。
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEK_BYTES = 32;

export interface KeyStore {
  readonly kind: 'dpapi' | 'file';
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<void>;
}

export function createKeyStore(dir: string, platform: NodeJS.Platform = process.platform): KeyStore {
  return platform === 'win32' ? new DpapiKeyStore(join(dir, 'vault.key.dpapi')) : new FileKeyStore(join(dir, 'vault.key'));
}

/** 保管済みの DEK を返す。無ければ作って保管する。 */
export async function loadOrCreateDek(store: KeyStore): Promise<Buffer> {
  const existing = await store.load();
  if (existing) {
    if (existing.length !== DEK_BYTES) throw new Error('vault key has an unexpected length');
    return existing;
  }
  const key = randomBytes(DEK_BYTES);
  await store.save(key);
  return key;
}

class FileKeyStore implements KeyStore {
  readonly kind = 'file' as const;
  constructor(private readonly path: string) {}

  async load(): Promise<Buffer | null> {
    if (!existsSync(this.path)) return null;
    return Buffer.from(readFileSync(this.path, 'utf8').trim(), 'base64');
  }

  async save(key: Buffer): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

// 値は argv に載せず env で PowerShell へ渡す (プロセス一覧に出さない)。
const DPAPI_SCRIPT = (op: 'Protect' | 'Unprotect') =>
  'Add-Type -AssemblyName System.Security; '
  + `$b = [Convert]::FromBase64String($env:EXCUBITOR_VAULT_DPAPI_IN); `
  + `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser'))`;

class DpapiKeyStore implements KeyStore {
  readonly kind = 'dpapi' as const;
  constructor(private readonly path: string) {}

  async load(): Promise<Buffer | null> {
    if (!existsSync(this.path)) return null;
    const protectedB64 = readFileSync(this.path, 'utf8').trim();
    return Buffer.from(await runDpapi('Unprotect', protectedB64), 'base64');
  }

  async save(key: Buffer): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, await runDpapi('Protect', key.toString('base64')), 'utf8');
  }
}

function runDpapi(op: 'Protect' | 'Unprotect', inputB64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT(op)],
      { windowsHide: true, timeout: 30_000, encoding: 'utf8', env: { ...process.env, EXCUBITOR_VAULT_DPAPI_IN: inputB64 } },
      (error, stdout) => {
        if (error) reject(new Error(`DPAPI ${op} failed`));
        else resolve(stdout.trim());
      },
    );
  });
}
