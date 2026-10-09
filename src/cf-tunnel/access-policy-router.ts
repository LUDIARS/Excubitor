/**
 * CF ブローカーの「通す人」API。トークンは cf-tunnel と同じく Excubitor 内だけ。
 *   GET  /api/v1/cf-access/identity-providers      … ログイン方法の一覧 {id, name, type} (config は返さない)
 *   GET  /api/v1/cf-access/policies/:id            … 再利用ポリシー 1 件の要約 (メール / ログイン方法 / その他の条件)
 *   PUT  /api/v1/cf-access/policies/:id/members    … {emails, login_method_ids, replace_other_rules?, apply?}
 *        Include を個別メールの列、Require をログイン方法の列に置き換える。既定は計画のみ (apply: true で書く)。
 *        応答に変更前の要約を入れるので、戻すときはその値で同じ API を呼ぶ。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md 要求 10)
 */

import { Hono } from 'hono';
import { createNamedLogger } from '../shared/logger.js';
import { planPolicyMembers, summarizePolicy } from './access-policy-service.js';
import { failureStatus } from './broker-support.js';
import { CloudflareAccessApi } from './cloudflare-access-api.js';
import { resolveCfCredentials } from './credentials.js';
import { RouteRejectedError } from './route-service.js';

const logger = createNamedLogger('excubitor.cf-tunnel.access-policy-router');

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new RouteRejectedError(`${field} は文字列の配列`);
  }
  return value as string[];
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function buildCfAccessPolicyRouter(): Hono {
  const app = new Hono();

  app.get('/api/v1/cf-access/identity-providers', async (c) => {
    try {
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      return c.json({ identity_providers: await access.listIdentityProviders() });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access identity providers list failed');
      return c.json({ error: 'cf_access_idps_failed', message: (err as Error).message }, 502);
    }
  });

  app.get('/api/v1/cf-access/policies/:id', async (c) => {
    try {
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      const [policy, idps] = await Promise.all([access.getPolicy(c.req.param('id')), access.listIdentityProviders()]);
      return c.json({ policy: summarizePolicy(policy, idps) });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access policy read failed');
      return c.json({ error: 'cf_access_policy_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  app.put('/api/v1/cf-access/policies/:id/members', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      emails?: unknown;
      login_method_ids?: unknown;
      replace_other_rules?: unknown;
      apply?: unknown;
    } | null;
    if (!body) return c.json({ error: 'bad_request', message: 'JSON body が必要' }, 400);
    try {
      const emails = stringList(body.emails, 'emails');
      const loginMethodIds = stringList(body.login_method_ids ?? [], 'login_method_ids');
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      const [policy, idps] = await Promise.all([access.getPolicy(c.req.param('id')), access.listIdentityProviders()]);
      const plan = planPolicyMembers(policy, idps, {
        emails,
        loginMethodIds,
        replaceOtherRules: body.replace_other_rules === true,
      });
      if (body.apply !== true || !plan.changed) {
        return c.json({ ok: true, applied: false, changed: plan.changed, before: plan.before, after: plan.after });
      }
      const updated = await access.updatePolicyRules(policy, plan);
      // メールは本人確認用の値なので件数だけをログに残す。
      logger.info({ policyId: policy.id, emails: plan.after.emails.length, loginMethods: plan.after.loginMethodIds.length }, 'cf-access policy members replaced');
      return c.json({ ok: true, applied: true, changed: true, before: plan.before, after: summarizePolicy(updated, idps) });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access policy members update failed');
      return c.json({ error: 'cf_access_policy_members_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  return app;
}
