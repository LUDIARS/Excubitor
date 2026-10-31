/** @implements SPEC-EX-NETWATCH */
/**
 * 遮断の希望状態 (人が登録した遮断の一覧) を持つ。 ファイル (`netwatch.block.file`) が正本で、
 * 管理者権限の同期タスクがそれを読んで Windows ファイアウォールに反映する。 期限が来たものは外す。
 * ファイルが読めない (壊れている) ときは、上書きで遮断を黙って消さないよう変更を受け付けない。
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BlockKind, BlockTarget } from './block-target.js';

export const BLOCKS_FILE_FORMAT = 'excubitor-netwatch-blocks';

export interface BlockEntry {
  id: string;
  kind: BlockKind;
  value: string;
  reason: string;
  /** 登録した人・道具 (x-excubitor-actor)。 */
  createdBy: string;
  createdAtMs: number;
  expiresAtMs: number;
}

const FileSchema = z.object({
  format: z.literal(BLOCKS_FILE_FORMAT),
  version: z.literal(1),
  blocks: z.array(z.object({
    id: z.string().uuid(),
    kind: z.enum(['address', 'program']),
    value: z.string().min(1),
    reason: z.string(),
    created_by: z.string(),
    created_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })),
});

export type RegistryHealth = { state: 'ok'; reason: null } | { state: 'failed'; reason: string };

export type AddResult =
  | { ok: true; entry: BlockEntry }
  | { ok: false; code: 'duplicate'; existing: BlockEntry }
  | { ok: false; code: 'full'; limit: number };

export class BlockRegistry {
  private entries: BlockEntry[] = [];
  private health: RegistryHealth = { state: 'ok', reason: null };

  /** ファイルの内容を読み込む。 ファイルが無ければ (null) 空で始める。 読めなければ failed にして変更を止める。 */
  load(text: string | null): void {
    if (text === null) {
      this.entries = [];
      this.health = { state: 'ok', reason: null };
      return;
    }
    try {
      const parsed = FileSchema.parse(JSON.parse(text));
      this.entries = parsed.blocks.map((block) => ({
        id: block.id,
        kind: block.kind,
        value: block.value,
        reason: block.reason,
        createdBy: block.created_by,
        createdAtMs: Date.parse(block.created_at),
        expiresAtMs: Date.parse(block.expires_at),
      }));
      this.health = { state: 'ok', reason: null };
    } catch (error) {
      this.entries = [];
      this.health = { state: 'failed', reason: `遮断ファイルを読めない: ${(error as Error).message.split('\n')[0]}` };
    }
  }

  /** ファイルを読めなかった (I/O エラー)。 内容を捨てずに変更を止める。 */
  fail(reason: string): void {
    this.entries = [];
    this.health = { state: 'failed', reason };
  }

  status(): RegistryHealth {
    return this.health;
  }

  /** 期限内のものを、 期限の近い順に。 */
  list(nowMs: number): BlockEntry[] {
    return this.entries.filter((entry) => entry.expiresAtMs > nowMs).sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  }

  /** 遮断を足す。 同じ対象が期限内にあれば足さずに既存を返す。 */
  add(target: BlockTarget, reason: string, createdBy: string, nowMs: number, ttlMs: number, maxEntries: number): AddResult {
    const active = this.list(nowMs);
    const existing = active.find((entry) => entry.kind === target.kind
      && entry.value.toLowerCase() === target.value.toLowerCase());
    if (existing) return { ok: false, code: 'duplicate', existing };
    if (active.length >= maxEntries) return { ok: false, code: 'full', limit: maxEntries };
    const entry: BlockEntry = {
      id: randomUUID(),
      kind: target.kind,
      value: target.value,
      reason,
      createdBy,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
    this.entries = [...active, entry];
    return { ok: true, entry };
  }

  /** 外す。 無ければ null。 */
  remove(id: string): BlockEntry | null {
    const target = this.entries.find((entry) => entry.id === id) ?? null;
    if (target) this.entries = this.entries.filter((entry) => entry.id !== id);
    return target;
  }

  /** 期限切れを捨てる。 捨てたら true (ファイルを書き直す合図)。 */
  expire(nowMs: number): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.expiresAtMs > nowMs);
    return this.entries.length !== before;
  }

  /** 失敗した書き込みの巻き戻し用。 */
  snapshot(): BlockEntry[] {
    return [...this.entries];
  }

  restore(entries: BlockEntry[]): void {
    this.entries = [...entries];
  }

  /** ファイルの内容。 同期タスクはこの形を読む。 */
  render(): string {
    const blocks = this.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      value: entry.value,
      reason: entry.reason,
      created_by: entry.createdBy,
      created_at: new Date(entry.createdAtMs).toISOString(),
      expires_at: new Date(entry.expiresAtMs).toISOString(),
    }));
    return `${JSON.stringify({ format: BLOCKS_FILE_FORMAT, version: 1, blocks }, null, 2)}\n`;
  }
}
