/** @implements SPEC-EX-DNS-FILTER */
/**
 * 問い合わせを受ける相手の範囲。 既定は loopback・LAN・Tailscale (CGNAT)・link-local だけで、
 * 外から届いた問い合わせには答えない (オープンリゾルバとして反射攻撃に使われないため)。
 */

import { overlaps, parseCidr, type CidrRange } from '../netwatch/cidr.js';

export const DEFAULT_ALLOWED_CLIENTS = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16',
  '::1/128', 'fc00::/7', 'fe80::/10',
];

export class ClientPolicy {
  private constructor(private readonly ranges: CidrRange[]) {}

  /** 既定 + config の追加分。 読めない追加分は設定エラーとして投げる。 */
  static build(extra: readonly string[]): ClientPolicy {
    const ranges = [...DEFAULT_ALLOWED_CLIENTS, ...extra].map((text) => {
      const range = parseCidr(text);
      if (!range) throw new Error(`dns_filter.allowed_clients: アドレスとして読めない: ${text}`);
      return range;
    });
    return new ClientPolicy(ranges);
  }

  /** 相手のアドレス (IPv4 射影の `::ffff:a.b.c.d` は IPv4 として見る) が範囲内か。 */
  allows(address: string): boolean {
    const plain = address.toLowerCase().startsWith('::ffff:') && address.includes('.') ? address.slice(7) : address;
    const single = parseCidr(plain);
    if (!single) return false;
    return this.ranges.some((range) => overlaps(single, range));
  }
}
