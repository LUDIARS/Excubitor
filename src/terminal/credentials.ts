import { sharedVault, type Vault } from '../vault/vault.js';
import { TerminalError, type CredentialsInput, type TerminalProfile } from './schema.js';

/** @implements SPEC-TERMINAL-CONNECTIONS */
export function credentialNames(id: string): Record<keyof Required<CredentialsInput>, string> {
  const prefix = `TERMINAL_${id.replaceAll('-', '').toUpperCase()}`;
  return { username: `${prefix}_USERNAME`, password: `${prefix}_PASSWORD`, privateKey: `${prefix}_PRIVATE_KEY`, passphrase: `${prefix}_PASSPHRASE` };
}

export async function saveCredentials(id: string, input: CredentialsInput, vault: Vault = sharedVault()): Promise<void> {
  const names = credentialNames(id);
  for (const key of Object.keys(input) as Array<keyof CredentialsInput>) {
    const value = input[key];
    if (value !== undefined) await vault.setEntry(names[key], value);
  }
}

export async function resolveCredentials(profile: TerminalProfile, vault: Pick<Vault, 'valuesOf'> = sharedVault()): Promise<CredentialsInput & { username: string }> {
  const names = credentialNames(profile.id);
  const keys = profile.auth === 'password' ? [names.username, names.password] : [names.username, names.privateKey, names.passphrase];
  const values = await vault.valuesOf(keys);
  const username = values[names.username];
  if (!username?.trim()) throw new TerminalError('username_missing');
  if (profile.auth === 'password') {
    const password = values[names.password];
    if (!password) throw new TerminalError('password_missing');
    return { username, password };
  }
  const privateKey = values[names.privateKey];
  if (!privateKey) throw new TerminalError('private_key_missing');
  return { username, privateKey, passphrase: values[names.passphrase] || undefined };
}
