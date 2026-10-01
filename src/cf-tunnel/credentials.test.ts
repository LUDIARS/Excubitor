import { describe, expect, it } from 'vitest';
import { resolveCfCredentials } from './credentials.js';

function vaultWith(values: Record<string, string>) {
  return { valuesOf: async (names: readonly string[]) => Object.fromEntries(names.filter((n) => n in values).map((n) => [n, values[n]!])) };
}

describe('resolveCfCredentials', () => {
  it('env 直指定があれば Vault を見ずに返す', async () => {
    const vault = { valuesOf: async () => { throw new Error('vault must not be read'); } };
    const creds = await resolveCfCredentials(
      { EXCUBITOR_CF_API_TOKEN: ' token-1 ', EXCUBITOR_CF_ACCOUNT_ID: 'acct-1' } as NodeJS.ProcessEnv,
      vault,
    );
    expect(creds).toEqual({ token: 'token-1', accountId: 'acct-1' });
  });

  it('env が無ければ Excubitor の Vault に登録した CF_API_TOKEN / CF_ACCOUNT_ID を使う', async () => {
    const creds = await resolveCfCredentials({} as NodeJS.ProcessEnv, vaultWith({ CF_API_TOKEN: 'vault-token', CF_ACCOUNT_ID: 'vault-acct' }));
    expect(creds).toEqual({ token: 'vault-token', accountId: 'vault-acct' });
  });

  it('env の片方だけなら残りを Vault から補う', async () => {
    const creds = await resolveCfCredentials(
      { EXCUBITOR_CF_ACCOUNT_ID: 'env-acct' } as NodeJS.ProcessEnv,
      vaultWith({ CF_API_TOKEN: 'vault-token', CF_ACCOUNT_ID: 'vault-acct' }),
    );
    expect(creds).toEqual({ token: 'vault-token', accountId: 'env-acct' });
  });

  it('揃わなければ欠けている名前を出して止まり、値は出さない', async () => {
    const error = await resolveCfCredentials({} as NodeJS.ProcessEnv, vaultWith({ CF_API_TOKEN: 'vault-token' })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/CF_ACCOUNT_ID/);
    expect((error as Error).message).not.toMatch(/CF_API_TOKEN \(/);
    expect((error as Error).message).not.toContain('vault-token');
  });
});
