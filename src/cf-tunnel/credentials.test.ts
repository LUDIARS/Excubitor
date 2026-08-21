import { describe, expect, it } from 'vitest';
import { resolveCfCredentials } from './credentials.js';

describe('resolveCfCredentials', () => {
  it('env 直指定があれば Infisical を見ずに返す', async () => {
    const creds = await resolveCfCredentials(
      { EXCUBITOR_CF_API_TOKEN: ' token-1 ', EXCUBITOR_CF_ACCOUNT_ID: 'acct-1' } as NodeJS.ProcessEnv,
      {},
    );
    expect(creds).toEqual({ token: 'token-1', accountId: 'acct-1' });
  });

  it('config store の project 指定は env 不在時の fallback として効く (identity 未設定なら明示エラー)', async () => {
    await expect(
      resolveCfCredentials({} as NodeJS.ProcessEnv, { infisicalProjectId: 'proj-1' }),
    ).rejects.toThrow(/machine identity/);
  });

  it('project がどこにも無ければ未設定エラー', async () => {
    await expect(resolveCfCredentials({} as NodeJS.ProcessEnv, {})).rejects.toThrow(/資格情報が未設定/);
  });
});
