/**
 * Cloudflare DNS REST client (zone の解決と CNAME レコードの読み書き)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { createNamedLogger } from '../shared/logger.js';
import { cfRequest } from './cloudflare-http.js';
import type { CfCredentials } from './credentials.js';

const logger = createNamedLogger('excubitor.cf-tunnel.dns-api');

export interface CfZone {
  id: string;
  name: string;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export class CloudflareDnsApi {
  constructor(private readonly creds: CfCredentials) {}

  /** 名前が完全一致するアカウント内の zone。無ければ null。 @implements SPEC-CF-TUNNEL-ROUTES */
  async findZone(name: string): Promise<CfZone | null> {
    const query = new URLSearchParams({ name, 'account.id': this.creds.accountId });
    const zones = await cfRequest<Array<{ id: string; name: string }>>(this.creds, 'GET', `/zones?${query}`);
    const zone = zones.find((z) => z.name.toLowerCase() === name.toLowerCase());
    return zone ? { id: zone.id, name: zone.name } : null;
  }

  /** @implements SPEC-CF-TUNNEL-ROUTES */
  async listRecords(zoneId: string, hostname: string): Promise<CfDnsRecord[]> {
    const query = new URLSearchParams({ name: hostname });
    const records = await cfRequest<
      Array<{ id: string; type: string; name: string; content: string; proxied?: boolean }>
    >(this.creds, 'GET', `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`);
    return records.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied === true }));
  }

  /** proxied CNAME を作る。 @implements SPEC-CF-TUNNEL-ROUTES */
  async createProxiedCname(zoneId: string, hostname: string, target: string): Promise<CfDnsRecord> {
    logger.info({ hostname }, 'creating proxied CNAME for tunnel route');
    const r = await cfRequest<{ id: string; type: string; name: string; content: string; proxied?: boolean }>(
      this.creds,
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      { type: 'CNAME', name: hostname, content: target, proxied: true, comment: 'Excubitor cf-tunnel broker' },
    );
    return { id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied === true };
  }

  /** レコードを 1 件消す。対象の選定は removal-service.ts が行う。 @implements SPEC-CF-TUNNEL-ROUTES */
  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    logger.info({ zoneId, recordId }, 'deleting DNS record for tunnel route');
    await cfRequest<unknown>(
      this.creds,
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    );
  }
}
