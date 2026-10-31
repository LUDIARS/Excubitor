/** @implements SPEC-EX-DNS-FILTER */
/**
 * API で足し引きする拒否規則を持つ。 ファイル (`dns_filter.rules_file`) が正本で、 Excubitor が
 * 起動し直しても残る。 期限つきの規則は期限で外す (期限なしは消すまで残る)。 ファイルが読めない
 * (壊れている) ときは、 上書きで規則を黙って消さないよう変更を受け付けない。
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const RULES_FILE_FORMAT = 'excubitor-dns-filter-rules';

export interface RuleEntry {
  id: string;
  /** 正規化したドメイン (配下も当たる)。 */
  domain: string;
  reason: string;
  /** 登録した人・道具 (x-excubitor-actor)。 */
  createdBy: string;
  createdAtMs: number;
  /** 期限なしは null。 */
  expiresAtMs: number | null;
}

const FileSchema = z.object({
  format: z.literal(RULES_FILE_FORMAT),
  version: z.literal(1),
  rules: z.array(z.object({
    id: z.string().uuid(),
    domain: z.string().min(1),
    reason: z.string(),
    created_by: z.string(),
    created_at: z.string().datetime(),
    expires_at: z.string().datetime().nullable(),
  })),
});

export type RegistryHealth = { state: 'ok'; reason: null } | { state: 'failed'; reason: string };

export type AddRuleResult =
  | { ok: true; entry: RuleEntry }
  | { ok: false; code: 'duplicate'; existing: RuleEntry }
  | { ok: false; code: 'full'; limit: number };

function active(entry: RuleEntry, nowMs: number): boolean {
  return entry.expiresAtMs === null || entry.expiresAtMs > nowMs;
}

export class RuleRegistry {
  private entries: RuleEntry[] = [];
  private health: RegistryHealth = { state: 'ok', reason: null };
  /** 規則が変わるたびに増える (判定用の集合を作り直す合図)。 */
  private revisionValue = 0;

  get revision(): number {
    return this.revisionValue;
  }

  /** ファイルの内容を読み込む。 ファイルが無ければ (null) 空で始める。 読めなければ failed にして変更を止める。 */
  load(text: string | null): void {
    this.revisionValue += 1;
    if (text === null) {
      this.entries = [];
      this.health = { state: 'ok', reason: null };
      return;
    }
    try {
      const parsed = FileSchema.parse(JSON.parse(text));
      this.entries = parsed.rules.map((rule) => ({
        id: rule.id,
        domain: rule.domain,
        reason: rule.reason,
        createdBy: rule.created_by,
        createdAtMs: Date.parse(rule.created_at),
        expiresAtMs: rule.expires_at === null ? null : Date.parse(rule.expires_at),
      }));
      this.health = { state: 'ok', reason: null };
    } catch (error) {
      this.entries = [];
      this.health = { state: 'failed', reason: `規則ファイルを読めない: ${(error as Error).message.split('\n')[0]}` };
    }
  }

  /** ファイルを読めなかった (I/O エラー)。 変更を止める。 */
  fail(reason: string): void {
    this.revisionValue += 1;
    this.entries = [];
    this.health = { state: 'failed', reason };
  }

  status(): RegistryHealth {
    return this.health;
  }

  /** 期限内のもの。 期限なしを先に、 その後は期限の近い順。 */
  list(nowMs: number): RuleEntry[] {
    return this.entries.filter((entry) => active(entry, nowMs)).sort((a, b) => {
      if (a.expiresAtMs === b.expiresAtMs) return a.createdAtMs - b.createdAtMs;
      if (a.expiresAtMs === null) return -1;
      if (b.expiresAtMs === null) return 1;
      return a.expiresAtMs - b.expiresAtMs;
    });
  }

  /** 規則を足す。 同じドメインが期限内にあれば足さずに既存を返す。 ttlMs が null なら期限なし。 */
  add(domain: string, reason: string, createdBy: string, nowMs: number, ttlMs: number | null, maxEntries: number): AddRuleResult {
    const current = this.list(nowMs);
    const existing = current.find((entry) => entry.domain === domain);
    if (existing) return { ok: false, code: 'duplicate', existing };
    if (current.length >= maxEntries) return { ok: false, code: 'full', limit: maxEntries };
    const entry: RuleEntry = {
      id: randomUUID(),
      domain,
      reason,
      createdBy,
      createdAtMs: nowMs,
      expiresAtMs: ttlMs === null ? null : nowMs + ttlMs,
    };
    this.entries = [...current, entry];
    this.revisionValue += 1;
    return { ok: true, entry };
  }

  /** 外す。 無ければ null。 */
  remove(id: string): RuleEntry | null {
    const target = this.entries.find((entry) => entry.id === id) ?? null;
    if (target) {
      this.entries = this.entries.filter((entry) => entry.id !== id);
      this.revisionValue += 1;
    }
    return target;
  }

  /** 期限切れを捨てる。 捨てたら true (ファイルを書き直す合図)。 */
  expire(nowMs: number): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => active(entry, nowMs));
    if (this.entries.length === before) return false;
    this.revisionValue += 1;
    return true;
  }

  /** 失敗した書き込みの巻き戻し用。 */
  snapshot(): RuleEntry[] {
    return [...this.entries];
  }

  restore(entries: RuleEntry[]): void {
    this.entries = [...entries];
    this.revisionValue += 1;
  }

  render(): string {
    const rules = this.entries.map((entry) => ({
      id: entry.id,
      domain: entry.domain,
      reason: entry.reason,
      created_by: entry.createdBy,
      created_at: new Date(entry.createdAtMs).toISOString(),
      expires_at: entry.expiresAtMs === null ? null : new Date(entry.expiresAtMs).toISOString(),
    }));
    return `${JSON.stringify({ format: RULES_FILE_FORMAT, version: 1, rules }, null, 2)}\n`;
  }
}
