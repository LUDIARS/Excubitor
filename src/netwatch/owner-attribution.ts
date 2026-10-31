/** @implements SPEC-EX-NETWATCH */
/**
 * 観測に送信元プロセスを付ける。 接続表は周期で読むので、 観測の時点の表に接続が無ければ
 * 次に表を読むまで待たせ、 期限までに見つからなければ不明のまま捨てる (推測しない)。
 */

import type { ConnectionTable } from './connection-table.js';
import type { DestinationStore } from './destination-store.js';
import type { OwnerResolver } from './owner-resolver.js';
import type { LocalEndpoint } from './types.js';

interface PendingLookup {
  remote: string;
  local: LocalEndpoint;
  expiresAtMs: number;
}

export interface AttributionCounters {
  /** 送信元プロセスが分かった観測数。 */
  attributed: number;
  /** 期限までに接続表に現れなかった観測数 (すぐ閉じた接続など)。 */
  expired: number;
}

export interface AttributionOptions {
  /** 表に無かった観測を待たせる時間。 */
  pendingTtlMs: number;
  /** 待たせる観測の上限。 超えたら古いものから捨てる。 */
  maxPending: number;
}

export class OwnerAttribution {
  readonly counters: AttributionCounters = { attributed: 0, expired: 0 };
  private table: ConnectionTable | null = null;
  private resolver: OwnerResolver | null = null;
  private pending: PendingLookup[] = [];

  constructor(private readonly store: DestinationStore, private readonly options: AttributionOptions) {}

  /** 観測 1 件。 今の表で引ければすぐ付け、 引けなければ次の表まで待たせる。 */
  observe(remote: string, local: LocalEndpoint, nowMs: number): void {
    if (this.attribute(remote, local)) return;
    this.pending.push({ remote, local, expiresAtMs: nowMs + this.options.pendingTtlMs });
    const overflow = this.pending.length - this.options.maxPending;
    if (overflow > 0) {
      this.pending.splice(0, overflow);
      this.counters.expired += overflow;
    }
  }

  /** 新しい接続表とプロセス一覧を受け、 待たせていた観測を引き直す。 */
  refresh(table: ConnectionTable, resolver: OwnerResolver, nowMs: number): void {
    this.table = table;
    this.resolver = resolver;
    const waiting = this.pending;
    this.pending = [];
    for (const lookup of waiting) {
      if (this.attribute(lookup.remote, lookup.local)) continue;
      if (lookup.expiresAtMs <= nowMs) this.counters.expired += 1;
      else this.pending.push(lookup);
    }
  }

  /** 表を読めなくなったとき (停止・失敗) は古い表で引かない。 */
  reset(): void {
    this.table = null;
    this.resolver = null;
    this.pending = [];
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private attribute(remote: string, local: LocalEndpoint): boolean {
    if (!this.table || !this.resolver) return false;
    const pid = this.table.ownerOf(local, remote);
    if (pid === null) return false;
    this.store.addOwner(remote, this.resolver.resolve(pid));
    this.counters.attributed += 1;
    return true;
  }
}
