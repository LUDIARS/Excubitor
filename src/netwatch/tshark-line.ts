/** @implements SPEC-EX-NETWATCH */
/**
 * tshark の 1 行 (タブ区切りのフィールド) を観測に変える。 列は tshark-command.ts の
 * TSHARK_FIELDS と同じ並び。 読めない行は null (呼び出し側で数えて捨てる)。
 */

import { TSHARK_AGGREGATOR, TSHARK_FIELDS } from './tshark-command.js';
import { normalizeCountry } from './locality.js';
import type { DnsAnswer, LocalEndpoint, ObservationKind, PacketObservation } from './types.js';

type FieldName = (typeof TSHARK_FIELDS)[number];

function columns(line: string): Map<FieldName, string> {
  const parts = line.replace(/\r$/, '').split('\t');
  const map = new Map<FieldName, string>();
  TSHARK_FIELDS.forEach((name, index) => map.set(name, (parts[index] ?? '').trim()));
  return map;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(TSHARK_AGGREGATOR).map((item) => item.trim()).filter(Boolean);
}

function first(value: string | undefined): string | null {
  return list(value)[0] ?? null;
}

function port(value: string | undefined): number | null {
  const parsed = Number(first(value));
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

/** ドメイン名を比較用に正規化する (小文字・末尾ドット除去)。 名前として不正なら null。 */
export function normalizeDomain(value: string | null): string | null {
  const name = value?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  if (!name || name.length > 253) return null;
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name) ? name : null;
}

function dnsAnswer(cols: Map<FieldName, string>): DnsAnswer | null {
  const name = normalizeDomain(first(cols.get('dns.qry.name')));
  const addresses = [...list(cols.get('dns.a')), ...list(cols.get('dns.aaaa'))];
  if (!name || addresses.length === 0) return null;
  return { name, addresses };
}

function kindOf(cols: Map<FieldName, string>): ObservationKind | null {
  if (first(cols.get('dns.flags.response')) === '1' || first(cols.get('dns.flags.response')) === 'True') return 'dns';
  if (cols.get('tls.handshake.extensions_server_name')) {
    return /(^|:)quic(:|$)/.test(cols.get('frame.protocols') ?? '') ? 'quic' : 'tls';
  }
  if (cols.get('http.host')) return 'http';
  const syn = first(cols.get('tcp.flags.syn'));
  const ack = first(cols.get('tcp.flags.ack'));
  if ((syn === '1' || syn === 'True') && (ack === '0' || ack === 'False')) return 'syn';
  return null;
}

/**
 * この PC 側の端点。 DNS 応答はこの PC が受けた側 (宛先ポート)、 それ以外はこの PC が
 * 始めた通信なので送信元ポート。
 */
function localEndpoint(cols: Map<FieldName, string>, isResponse: boolean): LocalEndpoint | null {
  if (isResponse) {
    const udp = port(cols.get('udp.dstport'));
    return udp === null ? null : { transport: 'udp', port: udp };
  }
  const tcp = port(cols.get('tcp.srcport'));
  if (tcp !== null) return { transport: 'tcp', port: tcp };
  const udp = port(cols.get('udp.srcport'));
  return udp === null ? null : { transport: 'udp', port: udp };
}

/** 1 行を観測にする。 種類・時刻・相手のアドレスが揃わない行は null。 */
export function parseTsharkLine(line: string): PacketObservation | null {
  if (!line.trim()) return null;
  const cols = columns(line);
  const kind = kindOf(cols);
  // 空欄を Number にすると 0 (1970 年) になるので、 値が無い行は時刻なしとして捨てる。
  const atText = cols.get('frame.time_epoch');
  const atSec = atText ? Number(atText) : NaN;
  if (!kind || !Number.isFinite(atSec)) return null;
  // DNS 応答は相手 (DNS サーバ) が送信元。 それ以外はこの PC が始めた通信なので宛先が相手。
  const isResponse = kind === 'dns';
  const remote = isResponse
    ? first(cols.get('ip.src')) ?? first(cols.get('ipv6.src'))
    : first(cols.get('ip.dst')) ?? first(cols.get('ipv6.dst'));
  if (!remote) return null;
  const country = isResponse
    ? normalizeCountry(first(cols.get('ip.geoip.src_country_iso')) ?? first(cols.get('ipv6.geoip.src_country_iso')))
    : normalizeCountry(first(cols.get('ip.geoip.dst_country_iso')) ?? first(cols.get('ipv6.geoip.dst_country_iso')));
  const serverName = kind === 'tls' || kind === 'quic'
    ? normalizeDomain(first(cols.get('tls.handshake.extensions_server_name')))
    : kind === 'http'
      ? normalizeDomain(first(cols.get('http.host'))?.replace(/:\d+$/, '') ?? null)
      : null;
  return {
    kind,
    atMs: Math.round(atSec * 1000),
    remote,
    port: isResponse ? port(cols.get('udp.srcport')) : port(cols.get('tcp.dstport')) ?? port(cols.get('udp.dstport')),
    serverName,
    dns: isResponse ? dnsAnswer(cols) : null,
    country,
    local: localEndpoint(cols, isResponse),
  };
}
