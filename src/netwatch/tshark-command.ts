/** @implements SPEC-EX-NETWATCH */
/**
 * tshark の起動引数を組み立てる。 1 パケット 1 行・タブ区切りで、 通信先を知るのに要る
 * フィールドだけを出させる (ペイロードは出させない)。 フィールドの並びは tshark-line.ts と対。
 */

/** 出力させるフィールド。 並び順が tshark-line.ts の列番号になる。 */
export const TSHARK_FIELDS = [
  'frame.time_epoch',
  'frame.protocols',
  'ip.src',
  'ip.dst',
  'ipv6.src',
  'ipv6.dst',
  'tcp.dstport',
  'udp.srcport',
  'udp.dstport',
  'tcp.flags.syn',
  'tcp.flags.ack',
  'dns.flags.response',
  'dns.qry.name',
  'dns.a',
  'dns.aaaa',
  'tls.handshake.extensions_server_name',
  'http.host',
  'ip.geoip.src_country_iso',
  'ip.geoip.dst_country_iso',
  'ipv6.geoip.src_country_iso',
  'ipv6.geoip.dst_country_iso',
  // 送信元プロセスを OS の接続表から引くための自分側ポート。 列番号を変えないよう末尾に足す。
  'tcp.srcport',
] as const;

/** 同じフィールドが複数回出たとき (DNS の複数応答など) の区切り。 */
export const TSHARK_AGGREGATOR = ',';

/**
 * 既定のキャプチャフィルタ (BPF)。 カーネル側で落として tshark の負荷を抑える。
 * - TCP の接続開始 (SYN のみ)
 * - DNS (53)
 * - TLS のハンドシェイクで始まる 443 の TCP セグメント (ClientHello)
 * - QUIC のロングヘッダ (Initial に SNI が載る)
 * - HTTP (80) の要求
 */
export const DEFAULT_CAPTURE_FILTER = [
  '(tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn)',
  '(udp port 53)',
  '(tcp port 443 and tcp[((tcp[12:1] & 0xf0) >> 2):1] = 0x16)',
  '(udp port 443 and udp[8] & 0xc0 == 0xc0)',
  '(tcp dst port 80)',
].join(' or ');

/** 行を出すパケットを絞る表示フィルタ。 */
export const DISPLAY_FILTER = [
  '(tcp.flags.syn == 1 && tcp.flags.ack == 0)',
  'tls.handshake.type == 1',
  'http.request',
  'dns.flags.response == 1',
].join(' || ');

export interface TsharkCommandOptions {
  /** キャプチャするインタフェース (`tshark -D` の名前か番号)。 */
  interface: string;
  captureFilter: string;
  /** `-N` に渡す名前解決フラグ。 外部 DNS 問い合わせ (n / N) は含めない。 */
  nameResolution: string;
}

/** `-N` に渡してよいフラグか。 n / N は tshark 自身が DNS を引いて通信を増やすので拒否する。 */
export function isAllowedNameResolution(flags: string): boolean {
  return /^[gdmtv]*$/.test(flags);
}

/** tshark の引数配列。 shell を介さず spawn に渡す。 */
export function buildTsharkArgs(options: TsharkCommandOptions): string[] {
  if (!options.interface.trim()) throw new Error('netwatch.interface is required');
  if (!isAllowedNameResolution(options.nameResolution)) {
    throw new Error(`netwatch.name_resolution must only contain g/d/m/t/v (got "${options.nameResolution}")`);
  }
  const args = [
    '-i', options.interface,
    '-l',
    '-f', options.captureFilter,
    '-Y', DISPLAY_FILTER,
    '-T', 'fields',
    '-E', 'header=n',
    '-E', 'separator=/t',
    '-E', 'quote=n',
    '-E', 'occurrence=a',
    '-E', `aggregator=${TSHARK_AGGREGATOR}`,
  ];
  // 空なら名前解決をすべて切る (-n)。 GeoIP (g) を使うときはフラグで明示する。
  if (options.nameResolution) args.push('-N', options.nameResolution);
  else args.push('-n');
  for (const field of TSHARK_FIELDS) args.push('-e', field);
  return args;
}
