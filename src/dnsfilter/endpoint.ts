/** @implements SPEC-EX-DNS-FILTER */
/**
 * 待受・上流のアドレス (`127.0.0.1:53` / `[::1]:53` / `1.1.1.1`) を読む。 名前は受けない
 * (Excubitor が上流の名前を引くと、 その問い合わせが自分自身を通って循環するため)。
 */

import { isIPv4, isIPv6 } from 'node:net';

export interface Endpoint {
  host: string;
  port: number;
  family: 4 | 6;
}

export type EndpointParse = { ok: true; endpoint: Endpoint } | { ok: false; reason: string };

export const DNS_PORT = 53;

function portOf(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** 1 件を読む。 ポートを省くと 53。 */
export function parseEndpoint(input: string): EndpointParse {
  const text = input.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  let host: string;
  let portText: string | undefined;
  if (bracketed) {
    host = bracketed[1]!;
    portText = bracketed[2];
  } else if (isIPv6(text)) {
    host = text;
  } else {
    const colon = text.lastIndexOf(':');
    host = colon < 0 ? text : text.slice(0, colon);
    portText = colon < 0 ? undefined : text.slice(colon + 1);
  }
  const family = isIPv4(host) ? 4 : isIPv6(host) ? 6 : null;
  if (family === null) return { ok: false, reason: `${text}: IP アドレス (と :port) で書く (名前は使えない)` };
  if (family === 6 && host.includes('%')) return { ok: false, reason: `${text}: スコープ付きの IPv6 は使えない` };
  const port = portText === undefined ? DNS_PORT : portOf(portText);
  if (port === null) return { ok: false, reason: `${text}: ポートが不正` };
  return { ok: true, endpoint: { host: host.toLowerCase(), port, family } };
}

/** カンマ区切りの一覧を読む。 1 件でも読めなければ全体を不正とする。 */
export function parseEndpointList(input: string): { ok: true; endpoints: Endpoint[] } | { ok: false; reason: string } {
  const items = input.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (items.length === 0) return { ok: false, reason: '空' };
  const endpoints: Endpoint[] = [];
  for (const item of items) {
    const parsed = parseEndpoint(item);
    if (!parsed.ok) return parsed;
    if (endpoints.some((endpoint) => sameEndpoint(endpoint, parsed.endpoint))) return { ok: false, reason: `${item}: 重複している` };
    endpoints.push(parsed.endpoint);
  }
  return { ok: true, endpoints };
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host === b.host && a.port === b.port;
}

export function formatEndpoint(endpoint: Endpoint): string {
  return endpoint.family === 6 ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`;
}

/** 待ち受けアドレスが「全部」 (0.0.0.0 / ::) か。 */
export function isWildcard(endpoint: Endpoint): boolean {
  return endpoint.host === '0.0.0.0' || endpoint.host === '::';
}
