import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { closeDb, openDb } from '../../db/index.js';
import { rememberMeshNonce } from './nonce-store.js';

it('persists consumed nonces across restart and separates workload identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-nonces-'));
  try {
    closeDb();
    openDb(join(dir, 'nonce.sqlite'));
    expect(rememberMeshNonce('a/ex', 'nonce', 2000, 1000)).toBe(true);
    closeDb();
    openDb(join(dir, 'nonce.sqlite'));
    expect(rememberMeshNonce('a/ex', 'nonce', 2000, 1001)).toBe(false);
    expect(rememberMeshNonce('b/ex', 'nonce', 2000, 1001)).toBe(true);
    expect(rememberMeshNonce('a/ex', 'nonce', 3000, 2001)).toBe(true);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
