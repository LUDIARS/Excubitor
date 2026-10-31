/** @implements SPEC-EX-NETWATCH */
/**
 * キャプチャした DNS 応答から「アドレス → 名前」を引けるようにする。 自分では DNS を引かない
 * (引くとその問い合わせ自体が通信になる)。 上限件数を超えたら古いものから捨てる。
 */

import type { DnsAnswer } from './types.js';

interface Entry {
  names: string[];
  seenMs: number;
}

/** 1 アドレスに覚える名前の上限 (CDN は同じアドレスに多数の名前が乗る)。 */
const NAMES_PER_ADDRESS = 5;

export class DnsAnswerCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxAddresses: number, private readonly ttlMs: number) {}

  /** 応答を覚える。 同じアドレスに来た新しい名前を先頭に置く。 */
  record(answer: DnsAnswer, atMs: number): void {
    for (const address of answer.addresses) {
      const key = address.toLowerCase();
      const previous = this.entries.get(key);
      const names = [answer.name, ...(previous?.names ?? []).filter((name) => name !== answer.name)]
        .slice(0, NAMES_PER_ADDRESS);
      // Map の挿入順を「最後に見た順」にするため、 消してから入れ直す。
      this.entries.delete(key);
      this.entries.set(key, { names, seenMs: atMs });
    }
    this.evict();
  }

  /** アドレスに対応する名前 (新しい順)。 期限切れ・未知なら空。 */
  namesFor(address: string, nowMs: number): string[] {
    const entry = this.entries.get(address.toLowerCase());
    if (!entry || nowMs - entry.seenMs > this.ttlMs) return [];
    return entry.names;
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (this.entries.size > this.maxAddresses) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
