/** @implements SPEC-EX-NETWATCH */
/**
 * 宛先アドレスの範囲判定。 private / loopback / link-local / multicast は国の判定対象にしない
 * (GeoIP は公開アドレスにしか国を返さず、 LAN 内の相手を「国不明」と並べると見落としの元になる)。
 */

import { isIP } from 'node:net';
import type { AddressScope } from './types.js';

/** 先頭 2 オクテット。 isIP が 4 と判定した値だけを渡すので 4 つ揃っている。 */
function ipv4Head(address: string): [number, number] {
  const [a = 0, b = 0] = address.split('.').map((part) => Number(part));
  return [a, b];
}

function ipv4Scope(address: string): AddressScope {
  const [a, b] = ipv4Head(address);
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // CGNAT (100.64.0.0/10)。 Tailscale もこの範囲を使う。
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a === 255) return 'multicast';
  return 'public';
}

function ipv6Scope(address: string): AddressScope {
  const lower = address.toLowerCase();
  if (lower === '::') return 'unspecified';
  if (lower === '::1') return 'loopback';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return ipv4Scope(mapped[1]);
  const head = parseInt(lower.split(':')[0] || '0', 16);
  if ((head & 0xffc0) === 0xfe80) return 'link-local';
  if ((head & 0xfe00) === 0xfc00) return 'private';
  if ((head & 0xff00) === 0xff00) return 'multicast';
  return 'public';
}

/** アドレスの範囲を返す。 IP として読めない値は null。 */
export function addressScope(address: string): AddressScope | null {
  const family = isIP(address);
  if (family === 4) return ipv4Scope(address);
  if (family === 6) return ipv6Scope(address);
  return null;
}
