/** @implements SPEC-EX-DNS-FILTER */
/**
 * テスト用: 問い合わせと上流の応答のバイト列を組み立てる。
 */

function encodeName(name: string): Buffer {
  const parts = name.length === 0 ? [] : name.split('.');
  return Buffer.concat([
    ...parts.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')])),
    Buffer.from([0]),
  ]);
}

function header(id: number, flags: number, counts: [number, number, number, number]): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt16BE(id, 0);
  buffer.writeUInt16BE(flags, 2);
  counts.forEach((count, index) => buffer.writeUInt16BE(count, 4 + index * 2));
  return buffer;
}

function question(name: string, type: number): Buffer {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([encodeName(name), tail]);
}

/** RD=1 の問い合わせ。 */
export function buildQueryPacket(name: string, type = 1, id = 0x1234, opcode = 0): Buffer {
  return Buffer.concat([header(id, 0x0100 | (opcode << 11), [1, 0, 0, 0]), question(name, type)]);
}

export interface TestRecord {
  type: number;
  /** A は `1.2.3.4`、 AAAA は 16 バイト、 CNAME は名前。 */
  data: string | Buffer;
}

/** 回答の所有者名は質問への圧縮ポインタ (0xc00c) で書く。 */
export function buildResponsePacket(
  name: string, type: number, records: TestRecord[], options: { id?: number; rcode?: number; questionName?: string } = {},
): Buffer {
  const answers = records.map((record) => {
    const rdata = typeof record.data === 'string'
      ? record.type === 1 ? Buffer.from(record.data.split('.').map(Number)) : encodeName(record.data)
      : record.data;
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0);
    fixed.writeUInt16BE(record.type, 2);
    fixed.writeUInt16BE(1, 4);
    fixed.writeUInt32BE(300, 6);
    fixed.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([fixed, rdata]);
  });
  return Buffer.concat([
    header(options.id ?? 0x1234, 0x8180 | (options.rcode ?? 0), [1, answers.length, 0, 0]),
    question(options.questionName ?? name, type),
    ...answers,
  ]);
}
