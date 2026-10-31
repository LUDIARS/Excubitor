/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { TSHARK_FIELDS, buildTsharkArgs, isAllowedNameResolution } from './tshark-command.js';
import { normalizeDomain, parseTsharkLine } from './tshark-line.js';

type Field = (typeof TSHARK_FIELDS)[number];

/** フィールド名で値を指定して tshark の 1 行 (タブ区切り) を作る。 */
function line(values: Partial<Record<Field, string>>): string {
  return TSHARK_FIELDS.map((name) => values[name] ?? '').join('\t');
}

describe('parseTsharkLine', () => {
  it('TLS ClientHello は宛先・ポート・SNI・宛先の国を取る', () => {
    const observation = parseTsharkLine(line({
      'frame.time_epoch': '1793411297.250000000',
      'frame.protocols': 'eth:ethertype:ip:tcp:tls',
      'ip.src': '192.168.1.10',
      'ip.dst': '142.250.196.110',
      'tcp.srcport': '51234',
      'tcp.dstport': '443',
      'tls.handshake.extensions_server_name': 'WWW.Example.COM.',
      'ip.geoip.dst_country_iso': 'us',
    }));
    expect(observation).toEqual({
      kind: 'tls',
      atMs: 1793411297250,
      remote: '142.250.196.110',
      port: 443,
      serverName: 'www.example.com',
      dns: null,
      country: 'US',
      local: { transport: 'tcp', port: 51234 },
    });
  });

  it('QUIC の Initial は quic として扱う', () => {
    const observation = parseTsharkLine(line({
      'frame.time_epoch': '1',
      'frame.protocols': 'eth:ethertype:ipv6:udp:quic:tls',
      'ipv6.dst': '2001:db8::1',
      'udp.dstport': '443',
      'tls.handshake.extensions_server_name': 'video.example.net',
    }));
    expect(observation?.kind).toBe('quic');
    expect(observation?.remote).toBe('2001:db8::1');
    expect(observation?.port).toBe(443);
    // この行には udp.srcport が無いので自分側ポートは取れない。
    expect(observation?.local).toBeNull();
  });

  it('自分側ポートは DNS 応答なら宛先ポート、 UDP の通信なら送信元ポート', () => {
    const dns = parseTsharkLine(line({
      'frame.time_epoch': '3', 'ip.src': '8.8.8.8', 'udp.srcport': '53', 'udp.dstport': '50001',
      'dns.flags.response': '1', 'dns.qry.name': 'a.example', 'dns.a': '203.0.113.9',
    }));
    expect(dns?.local).toEqual({ transport: 'udp', port: 50001 });
    const quic = parseTsharkLine(line({
      'frame.time_epoch': '4', 'frame.protocols': 'eth:ip:udp:quic:tls', 'ip.dst': '203.0.113.9',
      'udp.srcport': '61000', 'udp.dstport': '443', 'tls.handshake.extensions_server_name': 'a.example',
    }));
    expect(quic?.local).toEqual({ transport: 'udp', port: 61000 });
  });

  it('DNS 応答は送信元を相手にし、 名前と複数のアドレスを取る', () => {
    const observation = parseTsharkLine(line({
      'frame.time_epoch': '2',
      'ip.src': '8.8.8.8',
      'ip.dst': '192.168.1.10',
      'udp.srcport': '53',
      'udp.dstport': '50000',
      'dns.flags.response': '1',
      'dns.qry.name': 'cdn.example.org',
      'dns.a': '203.0.113.5,203.0.113.6',
      'dns.aaaa': '2001:db8::5',
      'ip.geoip.src_country_iso': 'US',
      'ip.geoip.dst_country_iso': 'JP',
    }));
    expect(observation).toMatchObject({
      kind: 'dns',
      remote: '8.8.8.8',
      port: 53,
      country: 'US',
      dns: { name: 'cdn.example.org', addresses: ['203.0.113.5', '203.0.113.6', '2001:db8::5'] },
    });
  });

  it('HTTP の Host はポートを外して名前にする', () => {
    const observation = parseTsharkLine(line({
      'frame.time_epoch': '3',
      'ip.dst': '198.51.100.7',
      'tcp.dstport': '80',
      'http.host': 'Plain.Example.com:8080',
    }));
    expect(observation).toMatchObject({ kind: 'http', serverName: 'plain.example.com', port: 80 });
  });

  it('SYN だけのパケットは syn。 True/False 表記も読む', () => {
    const observation = parseTsharkLine(line({
      'frame.time_epoch': '4',
      'ip.dst': '198.51.100.8',
      'tcp.dstport': '22',
      'tcp.flags.syn': 'True',
      'tcp.flags.ack': 'False',
    }));
    expect(observation).toMatchObject({ kind: 'syn', remote: '198.51.100.8', port: 22, serverName: null, country: null });
  });

  it('SYN-ACK・時刻なし・空行・相手なしは捨てる', () => {
    expect(parseTsharkLine(line({ 'frame.time_epoch': '5', 'ip.dst': '198.51.100.8', 'tcp.flags.syn': '1', 'tcp.flags.ack': '1' }))).toBeNull();
    expect(parseTsharkLine(line({ 'ip.dst': '198.51.100.8', 'tcp.flags.syn': '1', 'tcp.flags.ack': '0' }))).toBeNull();
    expect(parseTsharkLine('')).toBeNull();
    expect(parseTsharkLine(line({ 'frame.time_epoch': '6', 'tcp.flags.syn': '1', 'tcp.flags.ack': '0' }))).toBeNull();
  });

  it('CRLF の行末と不正な国コードを扱う', () => {
    const observation = parseTsharkLine(`${line({
      'frame.time_epoch': '7',
      'ip.dst': '198.51.100.9',
      'tcp.flags.syn': '1',
      'tcp.flags.ack': '0',
      'ip.geoip.dst_country_iso': 'Unknown',
    })}\r`);
    expect(observation?.country).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('名前として不正な値は null', () => {
    expect(normalizeDomain('exa mple.com')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('a'.repeat(254))).toBeNull();
    expect(normalizeDomain('Sub.Example.JP.')).toBe('sub.example.jp');
  });
});

describe('buildTsharkArgs', () => {
  it('フィールドを並び順どおり -e で渡し、 名前解決フラグを -N にする', () => {
    const args = buildTsharkArgs({ interface: 'Wi-Fi', captureFilter: 'tcp', nameResolution: 'g' });
    expect(args.slice(0, 2)).toEqual(['-i', 'Wi-Fi']);
    expect(args).toContain('-l');
    expect(args[args.indexOf('-N') + 1]).toBe('g');
    const fields = args.flatMap((value, index) => (args[index - 1] === '-e' ? [value] : []));
    expect(fields).toEqual([...TSHARK_FIELDS]);
  });

  it('名前解決フラグが空なら -n で全部切る', () => {
    const args = buildTsharkArgs({ interface: '1', captureFilter: 'tcp', nameResolution: '' });
    expect(args).toContain('-n');
    expect(args).not.toContain('-N');
  });

  it('外部 DNS を使うフラグ (n / N) とインタフェース未指定は拒否する', () => {
    expect(isAllowedNameResolution('gn')).toBe(false);
    expect(isAllowedNameResolution('N')).toBe(false);
    expect(isAllowedNameResolution('gd')).toBe(true);
    expect(() => buildTsharkArgs({ interface: '1', captureFilter: 'tcp', nameResolution: 'n' })).toThrow(/name_resolution/);
    expect(() => buildTsharkArgs({ interface: ' ', captureFilter: 'tcp', nameResolution: 'g' })).toThrow(/interface/);
  });
});
