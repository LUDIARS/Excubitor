import { join } from 'node:path';
import { Vault } from '../vault/vault.js';
import { vaultDir } from '../vault/vault-store.js';

/** Reuse Vault encryption, with a separate document and OS-protected key.
 * Never register this store as an environment Vault project or federation source.
 * @implements SPEC-TERMINAL-CONNECTIONS
 */
let credentials: Vault | undefined;
/** @implements SPEC-TERMINAL-CONNECTIONS */
export function terminalCredentialStore(): Vault {
  return credentials ??= new Vault({ dir: join(vaultDir(), 'terminal-credentials') });
}

const writes = new WeakMap<Vault, Promise<unknown>>();
/** Serialize save/import/delete, so a delayed import cannot replace a newer edit.
 * @implements SPEC-TERMINAL-CONNECTIONS
 */
export async function writeCredentials<T>(store: Vault, operation: () => Promise<T> | T): Promise<T> {
  const previous = writes.get(store) ?? Promise.resolve();
  const pending = previous.then(operation);
  const settled = pending.then(() => undefined, () => undefined);
  writes.set(store, settled);
  try { return await pending; }
  finally { if (writes.get(store) === settled) writes.delete(store); }
}
