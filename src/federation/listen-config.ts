/**
 * 拠点間専用リスナーの設定を解釈する (pure)。
 *
 * - `EXCUBITOR_FEDERATION_LISTEN`: bind するアドレス。 カンマ区切りで `host` / `host:port` /
 *   `[v6]:port`。 未設定なら拠点間リスナーは起動しない (既定 OFF)。
 *   Tailscale や Cloudflare Mesh の自拠点アドレス (例 `100.101.102.103`) を書く想定。
 * - `EXCUBITOR_FEDERATION_ALLOW_CIDRS`: 受け付ける接続元。 既定は Tailscale / CF Mesh が
 *   使う CGNAT 帯 (100.64.0.0/10) + Tailscale の IPv6 帯 + loopback。
 *
 * 0.0.0.0 / :: のような全インターフェース bind は受け付けない。 LAN やインターネット側の
 * インターフェースに管理系の口を開けないため。 アドレスは拠点ごとに違うので catalog
 * (git で全拠点共有) ではなく拠点ごとの env に置く。 port は省略すると Excubitor 自身の
 * catalog エントリの `ports` (role: federation) を使う。
 */

import { isIP } from 'node:net';

/** @implements SPEC-FEDERATION-MESH */

export const LISTEN_ENV = 'EXCUBITOR_FEDERATION_LISTEN';
export const ALLOW_CIDRS_ENV = 'EXCUBITOR_FEDERATION_ALLOW_CIDRS';

/**
 * 既定の接続元許可。
 * - 100.64.0.0/10: Tailscale の IPv4 (CGNAT 帯)。 Cloudflare Mesh (WARP) の 100.96.0.0/12 もこの中
 * - fd7a:115c:a1e0::/48: Tailscale の IPv6
 * - loopback: 同一ホストからの確認用
 */
export const DEFAULT_ALLOW_CIDRS = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48', '127.0.0.0/8', '::1/128'];

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*', '0:0:0:0:0:0:0:0']);

export interface ListenAddress {
  host: string;
  port: number;
}

export interface AllowedCidr {
  network: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

export type FederationListenConfig =
  | { enabled: false; error: null }
  | { enabled: false; error: string }
  | { enabled: true; addresses: ListenAddress[]; allow: AllowedCidr[] };

export function parseFederationListenConfig(
  env: Record<string, string | undefined>,
  defaultPort: number | null,
): FederationListenConfig {
  const raw = env[LISTEN_ENV]?.trim();
  if (!raw) return { enabled: false, error: null };

  const addresses: ListenAddress[] = [];
  for (const entry of splitList(raw)) {
    const parsed = parseListenEntry(entry, defaultPort);
    if (typeof parsed === 'string') return { enabled: false, error: `${LISTEN_ENV}: ${parsed}` };
    addresses.push(parsed);
  }
  if (addresses.length === 0) return { enabled: false, error: `${LISTEN_ENV}: no address given` };

  const allowRaw = env[ALLOW_CIDRS_ENV]?.trim();
  const allowEntries = allowRaw ? splitList(allowRaw) : DEFAULT_ALLOW_CIDRS;
  const allow: AllowedCidr[] = [];
  for (const entry of allowEntries) {
    const parsed = parseCidr(entry);
    if (typeof parsed === 'string') return { enabled: false, error: `${ALLOW_CIDRS_ENV}: ${parsed}` };
    allow.push(parsed);
  }
  if (allow.length === 0) return { enabled: false, error: `${ALLOW_CIDRS_ENV}: empty allowlist` };

  return { enabled: true, addresses, allow };
}

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** `host` / `host:port` / `[v6]` / `[v6]:port` / 素の IPv6 を解釈する。 失敗時は理由の文字列。 */
export function parseListenEntry(entry: string, defaultPort: number | null): ListenAddress | string {
  let host: string;
  let portText: string | null = null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    host = bracketed[1]!;
    portText = bracketed[2] ?? null;
  } else if (isIP(entry) === 6) {
    host = entry;
  } else {
    const colon = entry.lastIndexOf(':');
    if (colon >= 0) {
      host = entry.slice(0, colon);
      portText = entry.slice(colon + 1);
    } else {
      host = entry;
    }
  }
  if (!host) return `empty host in "${entry}"`;
  if (WILDCARD_HOSTS.has(host)) {
    return `refusing wildcard bind "${host}" (bind the Tailscale / Cloudflare Mesh address of this node instead)`;
  }
  const port = portText == null ? defaultPort : Number(portText);
  if (port == null) {
    return `no port for "${entry}" and the excubitor catalog entry declares no federation port`;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `invalid port in "${entry}"`;
  return { host, port };
}

/** `a.b.c.d/n` / `v6/n` / 単一 IP を解釈する。 失敗時は理由の文字列。 */
export function parseCidr(entry: string): AllowedCidr | string {
  const [network, prefixText] = entry.split('/');
  const version = isIP(network ?? '');
  if (version === 0) return `invalid address "${entry}"`;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return `invalid prefix in "${entry}"`;
  return { network: network!, prefix, family };
}
