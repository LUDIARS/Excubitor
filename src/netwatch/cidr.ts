/** @implements SPEC-EX-NETWATCH */
/**
 * IP アドレスと CIDR を数値の範囲として扱う (遮断対象と守る範囲の重なりを見るため)。
 */

import { isIPv4, isIPv6 } from 'node:net';

export interface CidrRange {
  family: 4 | 6;
  /** 範囲の先頭と末尾 (含む)。 */
  first: bigint;
  last: bigint;
  prefix: number;
  /** 正規化した表記 (`203.0.113.0/24`、 単一アドレスは prefix 付き)。 */
  text: string;
}

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv4FromBigInt(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

/** `::` 省略と埋め込み IPv4 を展開して 8 個の 16 bit に直す。 */
function ipv6ToBigInt(address: string): bigint {
  let text = address.toLowerCase().replace(/%.*$/, '');
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded) {
    const v4 = ipv4ToBigInt(embedded[1]!);
    text = `${text.slice(0, -embedded[1]!.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') as [string, string] : [text, null];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = tail === null ? headParts : [...headParts, ...Array<string>(missing).fill('0'), ...tailParts];
  return parts.reduce((value, part) => (value << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function ipv6FromBigInt(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  // 最も長い 0 の並び (2 個以上) を :: にする。
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/** `addr` か `addr/prefix` を範囲にする。 読めなければ null。 範囲の途中を指す表記は先頭に揃える。 */
export function parseCidr(input: string): CidrRange | null {
  const [address = '', prefixText, extra] = input.trim().split('/');
  if (extra !== undefined) return null;
  const family = isIPv4(address) ? 4 : isIPv6(address) && !address.includes('%') ? 6 : null;
  if (!family) return null;
  const bits = family === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefix < 0 || prefix > bits) return null;
  const value = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const hostBits = BigInt(bits - prefix);
  const first = (value >> hostBits) << hostBits;
  const last = first | ((1n << hostBits) - 1n);
  const base = family === 4 ? ipv4FromBigInt(first) : ipv6FromBigInt(first);
  return { family, first, last, prefix, text: `${base}/${prefix}` };
}

/** 2 つの範囲が 1 アドレスでも重なるか (別ファミリーは重ならない)。 */
export function overlaps(a: CidrRange, b: CidrRange): boolean {
  return a.family === b.family && a.first <= b.last && b.first <= a.last;
}
