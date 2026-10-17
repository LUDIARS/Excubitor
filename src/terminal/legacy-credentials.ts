import { sharedVault, type Vault } from '../vault/vault.js';
import { terminalCredentialStore, writeCredentials } from './credential-store.js';
import { credentialNames } from './credentials.js';

/** Explicit import only. Normal SSH execution never falls back to environment Vault.
 * @implements SPEC-TERMINAL-CONNECTIONS
 */
export async function importLegacyCredentials(id: string, destination: Vault = terminalCredentialStore(), source: Vault = sharedVault()): Promise<{ imported: number; preserved: number }> {
  return writeCredentials(destination, async () => {
    const values = await source.valuesOf(Object.values(credentialNames(id)));
    const result = await destination.importEntries(values);
    // Keep originals: operators may have bound those entries to another service.
    // Existing destination values always win, including deliberately cleared passphrases.
    return { imported: result.imported.length, preserved: result.unchanged.length + result.conflicts.length };
  });
}
