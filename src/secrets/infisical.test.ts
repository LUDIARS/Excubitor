import { describe, it, expect } from 'vitest';
import { readIdentity, toEnvMap, type InfisicalSecret } from './infisical.js';

describe('readIdentity', () => {
  it('必須 3 つが揃えば identity を返す', () => {
    const id = readIdentity({
      INFISICAL_SITE_URL: 'https://app.infisical.com/',
      INFISICAL_CLIENT_ID: 'cid',
      INFISICAL_CLIENT_SECRET: 'csec',
    } as NodeJS.ProcessEnv);
    expect(id).toEqual({ siteUrl: 'https://app.infisical.com', clientId: 'cid', clientSecret: 'csec' });
  });

  it('不足なら null', () => {
    expect(readIdentity({ INFISICAL_SITE_URL: 'x' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('toEnvMap', () => {
  const secrets: InfisicalSecret[] = [
    { secretKey: 'A', secretValue: '1' },
    { secretKey: 'B', secretValue: '2' },
    { secretKey: 'C', secretValue: '3' },
  ];

  it('全件を env map に変換', () => {
    expect(toEnvMap(secrets)).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('include 指定で絞る', () => {
    expect(toEnvMap(secrets, { include: ['A', 'C'] })).toEqual({ A: '1', C: '3' });
  });

  it('exclude 指定で除外', () => {
    expect(toEnvMap(secrets, { exclude: ['B'] })).toEqual({ A: '1', C: '3' });
  });

  it('prefix を前置', () => {
    expect(toEnvMap(secrets, { prefix: 'X_', include: ['A'] })).toEqual({ X_A: '1' });
  });
});
