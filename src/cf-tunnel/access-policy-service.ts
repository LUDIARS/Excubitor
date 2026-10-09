/**
 * 再利用 Access ポリシーの「通す人」を読み書きするための判断ロジック (純関数)。CF API 呼び出しは持たない
 * (cloudflare-access-api.ts / access-policy-router.ts が担う)。
 *
 * 扱う形は 1 つだけ: Include = 個別メールの列、Require = ログイン方法 (IdP) の列。
 * 既存ポリシーにそれ以外の条件 (グループ・ドメイン・国など) があるときは、書き換えで消えるので
 * 明示の `replaceOtherRules` が無い限り止める。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md 要求 10)
 */

import { RouteRejectedError } from './route-service.js';

/** CF Access のルール 1 件 (`{ email: { email } }` / `{ login_method: { id } }` など)。 */
export type CfAccessRule = Record<string, unknown>;

export interface CfAccessPolicyDetail {
  id: string;
  name: string;
  decision: string;
  include: CfAccessRule[];
  require: CfAccessRule[];
  exclude: CfAccessRule[];
}

export interface CfIdentityProvider {
  id: string;
  name: string;
  type: string;
}

export interface PolicySummary {
  id: string;
  name: string;
  decision: string;
  emails: string[];
  loginMethods: Array<{ id: string; name: string | null; type: string | null }>;
  /** メール・ログイン方法以外の条件の種類 (例 group / email_domain)。書き換えると消える。 */
  otherRules: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAILS = 50;

function ruleKind(rule: CfAccessRule): string {
  return Object.keys(rule)[0] ?? 'unknown';
}

function emailOf(rule: CfAccessRule): string | null {
  const value = (rule.email as { email?: unknown } | undefined)?.email;
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function loginMethodOf(rule: CfAccessRule): string | null {
  const value = (rule.login_method as { id?: unknown } | undefined)?.id;
  return typeof value === 'string' ? value : null;
}

/** ポリシーを読める形にまとめる。 @implements SPEC-CF-TUNNEL-ROUTES */
export function summarizePolicy(policy: CfAccessPolicyDetail, idps: CfIdentityProvider[]): PolicySummary {
  const emails: string[] = [];
  const loginMethods: PolicySummary['loginMethods'] = [];
  const other = new Set<string>();
  for (const rule of policy.include) {
    const email = emailOf(rule);
    if (email) emails.push(email);
    else other.add(`include.${ruleKind(rule)}`);
  }
  for (const rule of policy.require) {
    const id = loginMethodOf(rule);
    if (id) {
      const idp = idps.find((p) => p.id === id);
      loginMethods.push({ id, name: idp?.name ?? null, type: idp?.type ?? null });
    } else {
      other.add(`require.${ruleKind(rule)}`);
    }
  }
  for (const rule of policy.exclude) other.add(`exclude.${ruleKind(rule)}`);
  return { id: policy.id, name: policy.name, decision: policy.decision, emails, loginMethods, otherRules: [...other].sort() };
}

export interface MembersInput {
  emails: string[];
  loginMethodIds: string[];
  /** 既存の他条件 (グループ・ドメインなど) を消してよいと明示したときだけ true。 */
  replaceOtherRules: boolean;
}

export interface MembersPlan {
  include: CfAccessRule[];
  require: CfAccessRule[];
  exclude: CfAccessRule[];
  before: PolicySummary;
  after: { emails: string[]; loginMethodIds: string[] };
  changed: boolean;
}

/**
 * 「通すのはこのメールの人だけ、ログインはこの方法だけ」に置き換える計画を作る。
 * Allow ポリシーに限る。メールは 1〜50 件、ログイン方法は登録済みの IdP に限る。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function planPolicyMembers(
  policy: CfAccessPolicyDetail,
  idps: CfIdentityProvider[],
  input: MembersInput,
): MembersPlan {
  if (policy.decision !== 'allow') {
    throw new RouteRejectedError(`ポリシー "${policy.name}" は Allow ではない (decision=${policy.decision})`);
  }
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) throw new RouteRejectedError('emails が空 (誰も通れなくなる)');
  if (emails.length > MAX_EMAILS) throw new RouteRejectedError(`emails は ${MAX_EMAILS} 件まで`);
  const invalid = emails.filter((e) => !EMAIL.test(e));
  if (invalid.length > 0) throw new RouteRejectedError(`メールアドレスの形式が不正: ${invalid.join(', ')}`);
  const loginMethodIds = [...new Set(input.loginMethodIds.map((id) => id.trim()).filter(Boolean))];
  const unknown = loginMethodIds.filter((id) => !idps.some((p) => p.id === id));
  if (unknown.length > 0) throw new RouteRejectedError(`登録されていないログイン方法: ${unknown.join(', ')}`);

  const before = summarizePolicy(policy, idps);
  if (before.otherRules.length > 0 && !input.replaceOtherRules) {
    throw new RouteRejectedError(
      `ポリシーにメール・ログイン方法以外の条件がある (${before.otherRules.join(', ')})。消してよければ replace_other_rules を付ける`,
    );
  }
  const include = emails.map((email) => ({ email: { email } }));
  const require = loginMethodIds.map((id) => ({ login_method: { id } }));
  // exclude は「通さない人」。メールだけで絞る形にするので残すと意図が読めなくなる → 明示時のみ空にする。
  const exclude = input.replaceOtherRules ? [] : policy.exclude;
  const changed =
    JSON.stringify([...before.emails].sort()) !== JSON.stringify([...emails].sort()) ||
    JSON.stringify(before.loginMethods.map((m) => m.id).sort()) !== JSON.stringify([...loginMethodIds].sort()) ||
    before.otherRules.length > 0;
  return { include, require, exclude, before, after: { emails, loginMethodIds }, changed };
}
