/** @implements SPEC-EX-DNS-FILTER */
import { describe, expect, it } from 'vitest';
import { buildResponse, parseQuery, parseUpstreamResponse, RCODE, typeName } from './dns-message.js';
import { buildQueryPacket, buildResponsePacket } from './test-packets.js';

function query(name: string, type = 1) {
  const parsed = parseQuery(buildQueryPacket(name, type));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.query;
}

describe('parseQuery', () => {
  it('名前は小文字に揃え、 型と質問の終わりを返す', () => {
    const packet = buildQueryPacket('WWW.Example.COM', 28);
    const parsed = parseQuery(packet);
    expect(parsed).toMatchObject({ ok: true, query: { id: 0x1234, opcode: 0, name: 'www.example.com', type: 28, qclass: 1 } });
    expect(parsed.ok && parsed.query.questionEnd).toBe(packet.length);
  });

  it('ヘッダより短い・応答 (QR=1) は答えない (id=null)', () => {
    expect(parseQuery(Buffer.alloc(5))).toMatchObject({ ok: false, id: null });
    expect(parseQuery(buildResponsePacket('a.example', 1, []))).toMatchObject({ ok: false, id: null });
  });

  it('質問が読めない・圧縮ポインタを含むものは FORMERR 用に id を返す', () => {
    const truncated = buildQueryPacket('example.com').subarray(0, 16);
    expect(parseQuery(truncated)).toMatchObject({ ok: false, id: 0x1234 });
    const pointer = Buffer.concat([buildQueryPacket('').subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
    expect(parseQuery(pointer)).toMatchObject({ ok: false, id: 0x1234 });
  });
});

describe('buildResponse', () => {
  it('質問を写して QR・RA と RCODE を立て、 回答を空にする', () => {
    const packet = buildQueryPacket('blocked.example');
    const parsed = query('blocked.example');
    const response = buildResponse(packet, parsed, RCODE.NXDOMAIN);
    expect(response.readUInt16BE(0)).toBe(0x1234);
    expect(response.readUInt16BE(2)).toBe(0x8000 | 0x0100 | 0x0080 | 3);
    expect(response.readUInt16BE(6)).toBe(0);
    expect(response.subarray(12).equals(packet.subarray(12))).toBe(true);
  });
});

describe('parseUpstreamResponse', () => {
  it('A / AAAA を拾う (CNAME の先も含む)', () => {
    const v6 = Buffer.alloc(16);
    v6.writeUInt16BE(0x2001, 0);
    v6.writeUInt16BE(0x0db8, 2);
    v6.writeUInt16BE(1, 14);
    const response = buildResponsePacket('www.example.com', 1, [
      { type: 5, data: 'edge.example.net' },
      { type: 1, data: '203.0.113.7' },
      { type: 28, data: v6 },
    ]);
    expect(parseUpstreamResponse(response, query('www.example.com'))).toEqual({
      ok: true, answer: { rcode: 0, addresses: ['203.0.113.7', '2001:db8::1'] },
    });
  });

  it('ID・質問が問い合わせと違う応答は受けない', () => {
    expect(parseUpstreamResponse(buildResponsePacket('a.example', 1, [], { id: 9 }), query('a.example'))).toMatchObject({ ok: false });
    expect(parseUpstreamResponse(buildResponsePacket('a.example', 1, [], { questionName: 'b.example' }), query('a.example')))
      .toMatchObject({ ok: false, reason: '質問が問い合わせと違う' });
    expect(parseUpstreamResponse(buildResponsePacket('a.example', 28, []), query('a.example', 1))).toMatchObject({ ok: false });
  });

  it('途中で切れた回答は受けない', () => {
    const response = buildResponsePacket('a.example', 1, [{ type: 1, data: '203.0.113.7' }]);
    expect(parseUpstreamResponse(response.subarray(0, response.length - 2), query('a.example'))).toMatchObject({ ok: false });
  });

  it('RCODE をそのまま返す', () => {
    expect(parseUpstreamResponse(buildResponsePacket('none.example', 1, [], { rcode: 3 }), query('none.example')))
      .toEqual({ ok: true, answer: { rcode: 3, addresses: [] } });
  });
});

describe('typeName', () => {
  it('知っている型は名前、 知らない型は TYPE<番号>', () => {
    expect(typeName(65)).toBe('HTTPS');
    expect(typeName(999)).toBe('TYPE999');
  });
});
