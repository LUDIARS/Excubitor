/** @implements SPEC-EX-NETWATCH */
/**
 * 通信先 (アドレス単位) の集計を持つ。 観測を受けてドメイン・ポート・国・回数を積み、
 * 国外判定を付け直す。 上限件数を超えたら最後に見た時刻が古いものから捨てる。
 */

import { addressScope } from './address-scope.js';
import { classifyLocality } from './locality.js';
import type { Destination, ObservationKind, TrafficOwner } from './types.js';

/** 1 宛先に残すドメインとポートの上限。 */
const DOMAINS_PER_DESTINATION = 8;
const PORTS_PER_DESTINATION = 8;
const OWNERS_PER_DESTINATION = 4;

export interface DestinationHit {
  remote: string;
  atMs: number;
  kind: ObservationKind;
  port: number | null;
  country: string | null;
  /** この観測で分かったドメイン (SNI / Host / DNS 応答)。 */
  domains: string[];
}

function prepend<T>(values: T[], incoming: T[], limit: number): T[] {
  const merged = [...incoming, ...values.filter((value) => !incoming.includes(value))];
  return merged.slice(0, limit);
}

export class DestinationStore {
  private readonly destinations = new Map<string, Destination>();

  constructor(private readonly maxDestinations: number, private homeCountry: string) {}

  /** 自国を変えたら、 既にある宛先の判定も付け直す。 */
  setHomeCountry(homeCountry: string): void {
    if (homeCountry === this.homeCountry) return;
    this.homeCountry = homeCountry;
    for (const destination of this.destinations.values()) {
      destination.locality = classifyLocality(destination.scope, destination.country, homeCountry);
    }
  }

  /** 観測を積む。 IP として読めないアドレスは捨てて null。 */
  hit(input: DestinationHit): Destination | null {
    const key = input.remote.toLowerCase();
    const scope = addressScope(key);
    if (!scope) return null;
    const previous = this.destinations.get(key);
    // 国は一度分かったら、 後で付かなかった観測 (GeoIP の付かない DNS 応答など) で消さない。
    const country = input.country ?? previous?.country ?? null;
    const next: Destination = {
      remote: key,
      scope,
      country,
      locality: classifyLocality(scope, country, this.homeCountry),
      domains: prepend(previous?.domains ?? [], input.domains, DOMAINS_PER_DESTINATION),
      ports: input.port === null
        ? previous?.ports ?? []
        : prepend(previous?.ports ?? [], [input.port], PORTS_PER_DESTINATION),
      kinds: previous?.kinds.includes(input.kind) ? previous.kinds : [...(previous?.kinds ?? []), input.kind],
      firstSeenMs: previous ? Math.min(previous.firstSeenMs, input.atMs) : input.atMs,
      lastSeenMs: previous ? Math.max(previous.lastSeenMs, input.atMs) : input.atMs,
      packets: (previous?.packets ?? 0) + 1,
      owners: previous?.owners ?? [],
    };
    this.destinations.delete(key);
    this.destinations.set(key, next);
    this.evict();
    return next;
  }

  /**
   * 宛先に通信したプロセスを足す。 同じ pid は先頭へ寄せ直す。 宛先が既に捨てられていれば何もしない
   * (並びは観測で決めるので、 ここでは並べ替えない)。
   */
  addOwner(remote: string, owner: TrafficOwner): void {
    const destination = this.destinations.get(remote.toLowerCase());
    if (!destination) return;
    const rest = destination.owners.filter((known) => known.pid !== owner.pid);
    destination.owners = [owner, ...rest].slice(0, OWNERS_PER_DESTINATION);
  }

  /** 最後に見た時刻の新しい順。 */
  list(): Destination[] {
    return [...this.destinations.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  }

  get size(): number {
    return this.destinations.size;
  }

  clear(): void {
    this.destinations.clear();
  }

  private evict(): void {
    while (this.destinations.size > this.maxDestinations) {
      const oldest = this.destinations.keys().next().value;
      if (oldest === undefined) return;
      this.destinations.delete(oldest);
    }
  }
}
