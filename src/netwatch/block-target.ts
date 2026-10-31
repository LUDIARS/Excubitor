/** @implements SPEC-EX-NETWATCH */
/**
 * 遮断の対象 (アドレス範囲かプログラム) を検証して正規化する。 守る範囲・守るプログラムに
 * かかるものは拒否する (止めると Excubitor 自身や拠点間の通信、 OS の基本機能が止まるため)。
 * 同じ検証を管理者権限の同期タスク (scripts/netwatch-firewall-sync.ps1) でもう一度行う。
 */

import { basename, win32 } from 'node:path';
import { overlaps, parseCidr, type CidrRange } from './cidr.js';

export type BlockKind = 'address' | 'program';

export interface BlockTarget {
  kind: BlockKind;
  /** address は `203.0.113.0/24` 形式、 program は絶対パス。 */
  value: string;
}

/** 常に守る範囲。 全体・loopback・LAN・CGNAT (Tailscale)・link-local・multicast。 */
export const ALWAYS_PROTECTED_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16', '224.0.0.0/4', '255.255.255.255/32',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '::ffff:0:0/96',
];

/** 常に守るプログラム (実行ファイル名、 小文字)。 止めると DNS・認証・Tailscale が止まる。 */
export const ALWAYS_PROTECTED_PROGRAMS = [
  'svchost.exe', 'lsass.exe', 'services.exe', 'wininit.exe', 'csrss.exe', 'smss.exe', 'system',
  'tailscale.exe', 'tailscaled.exe', 'tailscale-ipn.exe',
];

/** 1 件で広すぎる範囲 (IPv4 は /8 より広い、 IPv6 は /32 より広い) は拒否する。 */
const MIN_PREFIX = { 4: 8, 6: 32 } as const;
const MAX_PATH_LENGTH = 260;

export interface ProtectionPolicy {
  ranges: CidrRange[];
  /** 小文字の実行ファイル名。 */
  programs: Set<string>;
  /** 小文字の絶対パス (Excubitor 自身の node.exe など)。 */
  programPaths: Set<string>;
}

export type TargetResult = { ok: true; target: BlockTarget } | { ok: false; reason: string };

/** 既定の守り + config の追加分から方針を作る。 読めない追加分は設定エラーとして投げる。 */
export function buildProtectionPolicy(
  extraRanges: readonly string[],
  extraPrograms: readonly string[],
  ownPrograms: readonly string[],
): ProtectionPolicy {
  const ranges = [...ALWAYS_PROTECTED_RANGES, ...extraRanges].map((text) => {
    const range = parseCidr(text);
    if (!range) throw new Error(`netwatch.block.protected_addresses: アドレスとして読めない: ${text}`);
    return range;
  });
  return {
    ranges,
    programs: new Set([...ALWAYS_PROTECTED_PROGRAMS, ...extraPrograms].map((name) => name.trim().toLowerCase())),
    programPaths: new Set(ownPrograms.map((path) => win32.normalize(path).toLowerCase())),
  };
}

function addressTarget(value: string, policy: ProtectionPolicy): TargetResult {
  const range = parseCidr(value);
  if (!range) return { ok: false, reason: 'アドレス (IPv4 / IPv6、 /prefix 可) として読めない' };
  if (range.prefix < MIN_PREFIX[range.family]) {
    return { ok: false, reason: `範囲が広すぎる (IPv${range.family} は /${MIN_PREFIX[range.family]} 以上)` };
  }
  const hit = policy.ranges.find((protectedRange) => overlaps(range, protectedRange));
  if (hit) return { ok: false, reason: `守る範囲 ${hit.text} と重なる` };
  return { ok: true, target: { kind: 'address', value: range.text } };
}

function programTarget(value: string, policy: ProtectionPolicy): TargetResult {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATH_LENGTH) return { ok: false, reason: 'パスの長さが不正' };
  // ドライブ文字から始まる絶対パスだけ (UNC・相対・ワイルドカード・環境変数は受けない)。
  if (!/^[A-Za-z]:\\/.test(trimmed) || /[*?"<>|%]/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) {
    return { ok: false, reason: 'ドライブ文字から始まる絶対パス (C:\\...\\x.exe) で指定する' };
  }
  // normalize は .. を畳んでしまうので、 その前に見る (同期タスクも同じ値で判定する)。
  if (trimmed.split(/[\\/]/).includes('..')) return { ok: false, reason: '.. を含むパスは受けない' };
  const normalized = win32.normalize(trimmed);
  if (!normalized.toLowerCase().endsWith('.exe')) return { ok: false, reason: '.exe を指定する' };
  const name = basename(normalized.replace(/\\/g, '/')).toLowerCase();
  if (policy.programs.has(name)) return { ok: false, reason: `守るプログラム ${name} は止めない` };
  if (policy.programPaths.has(normalized.toLowerCase())) return { ok: false, reason: 'Excubitor 自身が使うプログラムは止めない' };
  return { ok: true, target: { kind: 'program', value: normalized } };
}

/** 対象を検証して正規化する。 */
export function validateBlockTarget(kind: BlockKind, value: string, policy: ProtectionPolicy): TargetResult {
  return kind === 'address' ? addressTarget(value, policy) : programTarget(value, policy);
}
