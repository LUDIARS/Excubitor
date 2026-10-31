/** @implements SPEC-EX-DNS-FILTER */
/**
 * config の `dns_filter` と拠点の env から設定を決める。
 * - 規則 (API の登録先・固定の拒否 / 許可・DoH) は `dns_filter.enabled` なら使える (待ち受け前に規則を用意できる)
 * - 待ち受けは env `EXCUBITOR_DNS_FILTER_LISTEN` と `EXCUBITOR_DNS_FILTER_UPSTREAM` の両方を設定した拠点だけ。
 *   片方だけなら理由を返して動かさない (上流を推測しない・OS の DNS 設定へ逃げない)
 */

import { resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { ClientPolicy } from './client-policy.js';
import { DomainSet, KNOWN_DOH_DOMAINS, normalizeDomainList } from './domain-rules.js';
import { formatEndpoint, isWildcard, parseEndpoint, parseEndpointList, type Endpoint } from './endpoint.js';

export const LISTEN_ENV = 'EXCUBITOR_DNS_FILTER_LISTEN';
export const UPSTREAM_ENV = 'EXCUBITOR_DNS_FILTER_UPSTREAM';

export interface RuleSettings {
  /** API で足す規則のファイル (絶対パス)。 */
  file: string;
  maxRules: number;
  maxTtlMs: number;
  allowed: DomainSet;
  blocked: DomainSet;
  doh: DomainSet;
}

export interface ServerSettings {
  listen: Endpoint[];
  upstream: Endpoint;
  upstreamTimeoutMs: number;
  maxInFlight: number;
  queryLogSize: number;
  clients: ClientPolicy;
  /** config の追加の相手範囲 (変更の検出用)。 */
  extraClients: string[];
}

export interface ResolvedDnsFilterSettings {
  /** 無効なら null。 */
  rules: RuleSettings | null;
  /** 待ち受けない拠点は null。 */
  server: ServerSettings | null;
  /** rules か server が null の理由。 */
  disabledReason: string | null;
}

/** 待ち受けの変更を見分ける鍵 (変わったら開き直す)。 */
export function serverKey(server: ServerSettings): string {
  return [
    server.listen.map(formatEndpoint).join(','),
    formatEndpoint(server.upstream),
    server.upstreamTimeoutMs,
    server.maxInFlight,
    server.extraClients.join(','),
  ].join('|');
}

function resolveServer(catalog: Catalog, env: NodeJS.ProcessEnv): { server: ServerSettings | null; reason: string | null } {
  const config = catalog.dns_filter;
  const listenText = env[LISTEN_ENV]?.trim() ?? '';
  const upstreamText = env[UPSTREAM_ENV]?.trim() ?? '';
  if (!listenText) return { server: null, reason: `env ${LISTEN_ENV} が未設定 (この拠点では待ち受けない)` };
  if (!upstreamText) return { server: null, reason: `env ${UPSTREAM_ENV} が未設定 (上流を決めないと中継できない)` };
  const listen = parseEndpointList(listenText);
  if (!listen.ok) throw new Error(`${LISTEN_ENV}: ${listen.reason}`);
  const wildcard = listen.endpoints.find(isWildcard);
  if (wildcard) throw new Error(`${LISTEN_ENV}: ${formatEndpoint(wildcard)} は使えない (待ち受けるアドレスを指定する)`);
  const upstream = parseEndpoint(upstreamText);
  if (!upstream.ok) throw new Error(`${UPSTREAM_ENV}: ${upstream.reason}`);
  const loop = listen.endpoints.find((endpoint) => endpoint.host === upstream.endpoint.host && endpoint.port === upstream.endpoint.port);
  if (loop) throw new Error(`${UPSTREAM_ENV}: 自分の待ち受け ${formatEndpoint(loop)} を上流にはできない`);
  return {
    server: {
      listen: listen.endpoints,
      upstream: upstream.endpoint,
      upstreamTimeoutMs: config.upstream_timeout_ms,
      maxInFlight: config.max_in_flight,
      queryLogSize: config.query_log_size,
      clients: ClientPolicy.build(config.allowed_clients),
      extraClients: [...config.allowed_clients],
    },
    reason: null,
  };
}

/** 設定を決める。 不正な値は設定エラーとして投げる (呼び出し側が failed にする)。 */
export function resolveDnsFilterSettings(catalog: Catalog, env: NodeJS.ProcessEnv, cwd: string): ResolvedDnsFilterSettings {
  const config = catalog.dns_filter;
  if (!config.enabled) return { rules: null, server: null, disabledReason: 'dns_filter.enabled=false' };
  const rules: RuleSettings = {
    file: resolve(cwd, config.rules_file),
    maxRules: config.max_rules,
    maxTtlMs: config.max_ttl_min * 60_000,
    allowed: new DomainSet(normalizeDomainList('dns_filter.allowed_domains', config.allowed_domains)),
    blocked: new DomainSet(normalizeDomainList('dns_filter.blocked_domains', config.blocked_domains)),
    doh: new DomainSet(config.block_doh ? KNOWN_DOH_DOMAINS : []),
  };
  const { server, reason } = resolveServer(catalog, env);
  return { rules, server, disabledReason: reason };
}
