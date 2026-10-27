import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ fingerprint: digest, hashes: z.array(digest).min(2).max(4) }).strict();
const documentSchema = z.object({ version: z.literal(1), receipts: z.record(receiptSchema) }).strict();
export type OriginApproval = z.infer<typeof receiptSchema>;

/** Independent of incident reset; immutable approvals fail closed on mismatch/corruption. */
export class OriginApprovals {
  constructor(private readonly path: string) {}
  private read(): z.infer<typeof documentSchema> {
    let source: string;
    try { source = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, receipts: {} };
      throw error;
    }
    const doc = documentSchema.parse(JSON.parse(source));
    if (Object.keys(doc.receipts).length > 2000) throw new Error('origin approval capacity exceeded');
    return doc;
  }
  get(key: string): OriginApproval | undefined { return this.read().receipts[key]; }
  save(key: string, receipt: OriginApproval): void {
    const doc = this.read();
    const validated = receiptSchema.parse(receipt);
    const old = doc.receipts[key];
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(validated)) throw new Error('origin approval already differs');
      return;
    }
    if (Object.keys(doc.receipts).length >= 2000) throw new Error('origin approval capacity exceeded');
    doc.receipts[key] = validated;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(doc), 'utf8'); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.path);
    }
    finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
