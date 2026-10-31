/** @implements SPEC-EX-DNS-FILTER */
/**
 * DNS メッセージ (RFC 1035) のうち、 中継に要る部分だけを読む・作る。
 * - 問い合わせ: ヘッダと 1 件の質問 (名前・型) を読む
 * - 止めた / 断った / 失敗した問い合わせへの応答 (質問を写して RCODE を立てる)
 * - 上流の応答: 質問が問い合わせと同じかを確かめ、 A / AAAA のアドレスを拾う
 * 問い合わせの中身は書き換えず、 上流へはそのまま渡す。
 */

export const HEADER_BYTES = 12;
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;
export type Rcode = typeof RCODE[keyof typeof RCODE];

const TYPE_A = 1;
const TYPE_AAAA = 28;
const MAX_NAME_BYTES = 255;
/** 圧縮ポインタを辿る回数の上限 (ループする応答で止まらないため)。 */
const MAX_POINTER_HOPS = 32;

export interface DnsQuery {
  id: number;
  opcode: number;
  /** 小文字・末尾の点なし。 ルートは空文字。 */
  name: string;
  type: number;
  qclass: number;
  /** 質問の終わり (応答はここまでを写す)。 */
  questionEnd: number;
}

export type QueryParse =
  | { ok: true; query: DnsQuery }
  /** ヘッダは読めた (FORMERR を返せる)。 */
  | { ok: false; id: number; reason: string }
  /** ヘッダも読めない (応答しない)。 */
  | { ok: false; id: null; reason: string };

interface NameRead {
  name: string;
  /** 名前の直後の位置 (ポインタがあればポインタの直後)。 */
  end: number;
}

/** 名前を読む。 allowPointers=false (問い合わせ) では圧縮を受けない。 読めなければ null。 */
function readName(buffer: Buffer, start: number, allowPointers: boolean): NameRead | null {
  const labels: string[] = [];
  let offset = start;
  let end: number | null = null;
  let bytes = 0;
  for (let hops = 0; hops <= MAX_POINTER_HOPS;) {
    if (offset >= buffer.length) return null;
    const length = buffer[offset]!;
    if (length === 0) {
      return { name: labels.join('.').toLowerCase(), end: end ?? offset + 1 };
    }
    if ((length & 0xc0) === 0xc0) {
      if (!allowPointers || offset + 1 >= buffer.length) return null;
      end ??= offset + 2;
      offset = ((length & 0x3f) << 8) | buffer[offset + 1]!;
      hops += 1;
      continue;
    }
    if ((length & 0xc0) !== 0) return null;
    if (offset + 1 + length > buffer.length) return null;
    bytes += length + 1;
    if (bytes > MAX_NAME_BYTES) return null;
    labels.push(buffer.toString('latin1', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return null;
}

/** 問い合わせを読む。 応答 (QR=1)・質問が 1 件でないものは不正として扱う。 */
export function parseQuery(buffer: Buffer): QueryParse {
  if (buffer.length < HEADER_BYTES) return { ok: false, id: null, reason: 'ヘッダより短い' };
  const id = buffer.readUInt16BE(0);
  const flags = buffer.readUInt16BE(2);
  if (flags & 0x8000) return { ok: false, id: null, reason: '問い合わせではない (QR=1)' };
  const opcode = (flags >> 11) & 0x0f;
  if (buffer.readUInt16BE(4) !== 1) return { ok: false, id, reason: '質問は 1 件だけ受ける' };
  const name = readName(buffer, HEADER_BYTES, false);
  if (!name || name.end + 4 > buffer.length) return { ok: false, id, reason: '質問を読めない' };
  return {
    ok: true,
    query: {
      id,
      opcode,
      name: name.name,
      type: buffer.readUInt16BE(name.end),
      qclass: buffer.readUInt16BE(name.end + 2),
      questionEnd: name.end + 4,
    },
  };
}

/** 問い合わせに RCODE だけの応答を作る (質問は写す、 回答は空)。 */
export function buildResponse(request: Buffer, query: DnsQuery, rcode: Rcode): Buffer {
  const response = Buffer.from(request.subarray(0, query.questionEnd));
  const requestFlags = request.readUInt16BE(2);
  // QR=1、 opcode と RD は写し、 RA=1、 RCODE を立てる。
  const flags = 0x8000 | (requestFlags & 0x7800) | (requestFlags & 0x0100) | 0x0080 | rcode;
  response.writeUInt16BE(flags, 2);
  response.writeUInt16BE(1, 4);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

/** 質問を読めない問い合わせに返すヘッダだけの応答。 */
export function buildHeaderOnlyResponse(id: number, rcode: Rcode): Buffer {
  const response = Buffer.alloc(HEADER_BYTES);
  response.writeUInt16BE(id, 0);
  response.writeUInt16BE(0x8000 | 0x0080 | rcode, 2);
  return response;
}

function formatIpv6(buffer: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let index = 0; index < 8; index += 1) groups.push(buffer.readUInt16BE(offset + index * 2).toString(16));
  // 正規化 (:: の短縮) は netwatch 側のキーに合わせ、 最も長い 0 の並びを畳む。
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== '0') { index += 1; continue; }
    let end = index;
    while (end < 8 && groups[end] === '0') end += 1;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  if (bestStart < 0) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

export interface UpstreamAnswer {
  rcode: number;
  /** A / AAAA のアドレス (回答欄にあるもの全部。 CNAME の先も含む)。 */
  addresses: string[];
}

export type AnswerParse = { ok: true; answer: UpstreamAnswer } | { ok: false; reason: string };

/**
 * 上流の応答を確かめて読む。 ID・質問 (名前・型・クラス) が問い合わせと同じでなければ不正
 * (別の問い合わせへの応答や偽の応答を返さない)。
 */
export function parseUpstreamResponse(buffer: Buffer, query: DnsQuery): AnswerParse {
  if (buffer.length < HEADER_BYTES) return { ok: false, reason: 'ヘッダより短い' };
  if (buffer.readUInt16BE(0) !== query.id) return { ok: false, reason: 'ID が違う' };
  const flags = buffer.readUInt16BE(2);
  if (!(flags & 0x8000)) return { ok: false, reason: '応答ではない (QR=0)' };
  if (buffer.readUInt16BE(4) !== 1) return { ok: false, reason: '質問が 1 件ではない' };
  const question = readName(buffer, HEADER_BYTES, true);
  if (!question || question.end + 4 > buffer.length) return { ok: false, reason: '質問を読めない' };
  if (question.name !== query.name
    || buffer.readUInt16BE(question.end) !== query.type
    || buffer.readUInt16BE(question.end + 2) !== query.qclass) {
    return { ok: false, reason: '質問が問い合わせと違う' };
  }
  const addresses: string[] = [];
  let offset = question.end + 4;
  const answerCount = buffer.readUInt16BE(6);
  for (let index = 0; index < answerCount; index += 1) {
    const owner = readName(buffer, offset, true);
    if (!owner || owner.end + 10 > buffer.length) return { ok: false, reason: '回答を読めない' };
    const type = buffer.readUInt16BE(owner.end);
    const length = buffer.readUInt16BE(owner.end + 8);
    const data = owner.end + 10;
    if (data + length > buffer.length) return { ok: false, reason: '回答が途中で切れている' };
    if (type === TYPE_A && length === 4) addresses.push([...buffer.subarray(data, data + 4)].join('.'));
    if (type === TYPE_AAAA && length === 16) addresses.push(formatIpv6(buffer, data));
    offset = data + length;
  }
  return { ok: true, answer: { rcode: flags & 0x000f, addresses } };
}

const TYPE_NAMES: Record<number, string> = {
  1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 64: 'SVCB', 65: 'HTTPS', 255: 'ANY',
};

/** 履歴に出す型の名前 (知らない型は TYPE<番号>)。 */
export function typeName(type: number): string {
  return TYPE_NAMES[type] ?? `TYPE${type}`;
}
