/** @implements SPEC-EX-NETWATCH */
/**
 * 国外判定。 国は Wireshark の MaxMind 解決 (ip.geoip.*) が付けた値だけを使い、
 * ドメインの TLD などから推測しない (.com は国を表さず、 推測で「国内」と出すと見落とす)。
 */

import type { AddressScope, Locality } from './types.js';

/** ISO 3166-1 alpha-2 として読める国コードだけを大文字で返す。 */
export function normalizeCountry(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * 範囲と国から国外かどうかを決める。 公開アドレスで国が分からないものは unknown のまま
 * (国外とも国内とも言わない)。
 */
export function classifyLocality(scope: AddressScope, country: string | null, homeCountry: string): Locality {
  if (scope !== 'public') return 'local';
  if (!country) return 'unknown';
  return country === homeCountry ? 'domestic' : 'foreign';
}
