import { describe, expect, it } from 'vitest';
import {
  planPolicyMembers,
  summarizePolicy,
  type CfAccessPolicyDetail,
  type CfIdentityProvider,
} from './access-policy-service.js';
import { RouteRejectedError } from './route-service.js';

const IDPS: CfIdentityProvider[] = [
  { id: 'idp-google', name: 'Google BUSINESS', type: 'google' },
  { id: 'idp-otp', name: 'One-time PIN', type: 'onetimepin' },
];

function policy(overrides: Partial<CfAccessPolicyDetail> = {}): CfAccessPolicyDetail {
  return {
    id: 'pol-1',
    name: 'BUSINESS',
    decision: 'allow',
    include: [{ email: { email: 'old@example.com' } }],
    require: [],
    exclude: [],
    ...overrides,
  };
}

describe('summarizePolicy', () => {
  it('メールとログイン方法を読み、それ以外の条件は種類だけを出す', () => {
    const summary = summarizePolicy(
      policy({
        include: [{ email: { email: 'A@Example.com' } }, { email_domain: { domain: 'example.com' } }],
        require: [{ login_method: { id: 'idp-google' } }, { geo: { country_code: 'JP' } }],
        exclude: [{ email: { email: 'x@example.com' } }],
      }),
      IDPS,
    );
    expect(summary.emails).toEqual(['a@example.com']);
    expect(summary.loginMethods).toEqual([{ id: 'idp-google', name: 'Google BUSINESS', type: 'google' }]);
    expect(summary.otherRules).toEqual(['exclude.email', 'include.email_domain', 'require.geo']);
  });
});

describe('planPolicyMembers', () => {
  it('Include を指定メール、Require を指定ログイン方法に置き換える', () => {
    const plan = planPolicyMembers(policy(), IDPS, {
      emails: ['First@Example.com', 'second@example.com', 'first@example.com'],
      loginMethodIds: ['idp-google'],
      replaceOtherRules: false,
    });
    expect(plan.include).toEqual([{ email: { email: 'first@example.com' } }, { email: { email: 'second@example.com' } }]);
    expect(plan.require).toEqual([{ login_method: { id: 'idp-google' } }]);
    expect(plan.exclude).toEqual([]);
    expect(plan.before.emails).toEqual(['old@example.com']);
    expect(plan.changed).toBe(true);
  });

  it('同じ内容なら changed は false', () => {
    const plan = planPolicyMembers(policy(), IDPS, { emails: ['old@example.com'], loginMethodIds: [], replaceOtherRules: false });
    expect(plan.changed).toBe(false);
  });

  it('Allow 以外・空・不正なメール・未登録のログイン方法は拒否する', () => {
    const base = { emails: ['a@example.com'], loginMethodIds: [], replaceOtherRules: false };
    expect(() => planPolicyMembers(policy({ decision: 'bypass' }), IDPS, base)).toThrow(RouteRejectedError);
    expect(() => planPolicyMembers(policy(), IDPS, { ...base, emails: [' '] })).toThrow(/空/);
    expect(() => planPolicyMembers(policy(), IDPS, { ...base, emails: ['not-an-email'] })).toThrow(/形式/);
    expect(() => planPolicyMembers(policy(), IDPS, { ...base, loginMethodIds: ['idp-none'] })).toThrow(/登録されていない/);
  });

  it('メール・ログイン方法以外の条件があると、明示しない限り消さない', () => {
    const withDomain = policy({ include: [{ email_domain: { domain: 'example.com' } }], exclude: [{ email: { email: 'x@example.com' } }] });
    const input = { emails: ['a@example.com'], loginMethodIds: ['idp-google'], replaceOtherRules: false };
    expect(() => planPolicyMembers(withDomain, IDPS, input)).toThrow(/replace_other_rules/);
    const plan = planPolicyMembers(withDomain, IDPS, { ...input, replaceOtherRules: true });
    expect(plan.include).toEqual([{ email: { email: 'a@example.com' } }]);
    expect(plan.exclude).toEqual([]);
    expect(plan.changed).toBe(true);
  });
});
