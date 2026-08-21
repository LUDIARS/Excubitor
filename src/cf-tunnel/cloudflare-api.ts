/**
 * Cloudflare Tunnel REST client (cfd_tunnel の一覧と remote-managed configuration の読み書き)。
 *
 * CF API の envelope ({success, errors, result}) をここで畳み、呼び出し側には
 * result だけを返す。トークンはヘッダにのみ使い、ログ・エラーに含めない (§14)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { createNamedLogger } from '../shared/logger.js';
import type { CfCredentials } from './credentials.js';

const logger = createNamedLogger('excubitor.cf-tunnel.api');

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CfTunnelSummary {
  id: string;
  name: string;
  status: string;
}

/** ingress の 1 エントリ。未知フィールド (originRequest 等) は素通しで保持する。 */
export interface CfIngressRule {
  hostname?: string;
  path?: string;
  service: string;
  [key: string]: unknown;
}

export interface CfTunnelConfig {
  ingress?: CfIngressRule[];
  [key: string]: unknown;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export class CloudflareTunnelApi {
  constructor(private readonly creds: CfCredentials) {}

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${CF_API_BASE}/accounts/${this.creds.accountId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.creds.token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let envelope: CfEnvelope<T>;
    try {
      envelope = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new Error(`Cloudflare API ${method} ${path} → HTTP ${res.status} (非 JSON 応答)`);
    }
    if (!res.ok || !envelope.success) {
      const detail = (envelope.errors ?? [])
        .map((e) => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`)
        .join('; ');
      throw new Error(`Cloudflare API ${method} ${path} → ${res.status} ${detail || '(詳細なし)'}`);
    }
    return envelope.result;
  }

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  async listTunnels(): Promise<CfTunnelSummary[]> {
    const result = await this.request<Array<{ id: string; name: string; status?: string }>>(
      'GET',
      '/cfd_tunnel?is_deleted=false',
    );
    return result.map((t) => ({ id: t.id, name: t.name, status: t.status ?? 'unknown' }));
  }

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  async getConfiguration(tunnelId: string): Promise<CfTunnelConfig> {
    const result = await this.request<{ config: CfTunnelConfig | null }>(
      'GET',
      `/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
    );
    return result.config ?? {};
  }

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  async putConfiguration(tunnelId: string, config: CfTunnelConfig): Promise<CfTunnelConfig> {
    logger.info(
      { tunnelId, ingressCount: config.ingress?.length ?? 0 },
      'updating tunnel configuration',
    );
    const result = await this.request<{ config: CfTunnelConfig | null }>(
      'PUT',
      `/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      { config },
    );
    return result.config ?? {};
  }
}
