/**
 * Cloudflare Tunnel REST client (cfd_tunnel の一覧と remote-managed configuration の読み書き)。
 *
 * envelope の畳み込みとトークンの扱いは cloudflare-http.ts に一本化している (§14)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { createNamedLogger } from '../shared/logger.js';
import { cfRequest } from './cloudflare-http.js';
import type { CfCredentials } from './credentials.js';

const logger = createNamedLogger('excubitor.cf-tunnel.api');

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

/** @implements SPEC-CF-TUNNEL-ROUTES */
export class CloudflareTunnelApi {
  constructor(private readonly creds: CfCredentials) {}

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return cfRequest<T>(this.creds, method, `/accounts/${this.creds.accountId}${path}`, body);
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

  /**
   * tunnel を消す。接続中の cloudflared を切る cascade は使わない (接続中なら CF が拒否する)。
   * 削除してよいかの判断は removal-service.ts が行う。
   * @implements SPEC-CF-TUNNEL-ROUTES
   */
  async deleteTunnel(tunnelId: string): Promise<void> {
    logger.info({ tunnelId }, 'deleting tunnel');
    await this.request<unknown>('DELETE', `/cfd_tunnel/${encodeURIComponent(tunnelId)}`);
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
