/**
 * Cloudflare Zero Trust Access REST client (再利用ポリシー・Access アプリ・組織)。
 * AUD は Excubitor 内で runtime-config へ書くためだけに読み、API 応答・ログへは出さない。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { createNamedLogger } from '../shared/logger.js';
import { cfRequest } from './cloudflare-http.js';
import type { CfCredentials } from './credentials.js';

const logger = createNamedLogger('excubitor.cf-tunnel.access-api');

export interface CfAccessPolicy {
  id: string;
  name: string;
  decision: string;
}

export interface CfAccessApp {
  id: string;
  name: string;
  domain: string;
  aud: string;
  type: string;
}

export interface CreateAccessAppInput {
  name: string;
  domain: string;
  policyId: string;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export class CloudflareAccessApi {
  constructor(private readonly creds: CfCredentials) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return cfRequest<T>(this.creds, method, `/accounts/${this.creds.accountId}${path}`, body);
  }

  /** アカウントの再利用ポリシー。 @implements SPEC-CF-TUNNEL-ROUTES */
  async listReusablePolicies(): Promise<CfAccessPolicy[]> {
    const result = await this.request<Array<{ id: string; name?: string; decision?: string }>>(
      'GET',
      '/access/policies',
    );
    return result.map((p) => ({ id: p.id, name: p.name ?? '', decision: p.decision ?? 'unknown' }));
  }

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  async listApps(): Promise<CfAccessApp[]> {
    const result = await this.request<
      Array<{ id: string; name?: string; domain?: string; aud?: string; type?: string }>
    >('GET', '/access/apps');
    return result.map((a) => ({
      id: a.id,
      name: a.name ?? '',
      domain: a.domain ?? '',
      aud: a.aud ?? '',
      type: a.type ?? 'unknown',
    }));
  }

  /** self-hosted アプリを 1 件作り、既存の再利用ポリシーを付ける。 @implements SPEC-CF-TUNNEL-ROUTES */
  async createSelfHostedApp(input: CreateAccessAppInput): Promise<CfAccessApp> {
    logger.info({ domain: input.domain, name: input.name }, 'creating access application');
    const a = await this.request<{ id: string; name?: string; domain?: string; aud?: string; type?: string }>(
      'POST',
      '/access/apps',
      {
        name: input.name,
        domain: input.domain,
        type: 'self_hosted',
        session_duration: '24h',
        app_launcher_visible: true,
        policies: [{ id: input.policyId, precedence: 1 }],
      },
    );
    return { id: a.id, name: a.name ?? input.name, domain: a.domain ?? input.domain, aud: a.aud ?? '', type: a.type ?? 'self_hosted' };
  }

  /** Access アプリを 1 件削除する (ポリシーは残る)。 @implements SPEC-CF-TUNNEL-ROUTES */
  async deleteApp(appId: string): Promise<void> {
    logger.info({ appId }, 'deleting access application');
    await this.request<unknown>('DELETE', `/access/apps/${encodeURIComponent(appId)}`);
  }

  /** Zero Trust 組織の認証ドメイン (`<team>.cloudflareaccess.com`)。 @implements SPEC-CF-TUNNEL-ROUTES */
  async authDomain(): Promise<string> {
    const org = await this.request<{ auth_domain?: string }>('GET', '/access/organizations');
    return (org.auth_domain ?? '').toLowerCase();
  }
}
