/**
 * 拠点間リスナーの接続元制限。
 *
 * token 認証が本来の認可だが、 bind したインターフェースに想定外の経路 (LAN 側のルーティング等)
 * から届いた接続は token を見る前に落とす。 判定は Node の net.BlockList (CIDR 照合) に任せる。
 */

import { BlockList, isIP } from 'node:net';
import type { AllowedCidr } from './listen-config.js';

/** @implements SPEC-FEDERATION-MESH */

export interface SourceGuard {
  isAllowed: (address: string | null | undefined) => boolean;
}

export function createSourceGuard(allow: readonly AllowedCidr[]): SourceGuard {
  const list = new BlockList();
  for (const cidr of allow) list.addSubnet(cidr.network, cidr.prefix, cidr.family);
  return {
    isAllowed: (address) => {
      const normalized = normalizeAddress(address);
      if (!normalized) return false;
      const version = isIP(normalized);
      if (version === 0) return false;
      return list.check(normalized, version === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

/**
 * socket の remoteAddress を照合できる形へ揃える (pure)。
 * dual-stack の socket は IPv4 接続元を `::ffff:100.1.2.3` (IPv4-mapped) で返すので IPv4 へ戻す。
 * zone id (`fe80::1%eth0`) は落とす。
 */
export function normalizeAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const withoutZone = address.split('%')[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone);
  return mapped ? mapped[1]! : withoutZone;
}
