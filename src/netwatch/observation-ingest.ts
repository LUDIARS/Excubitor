/** @implements SPEC-EX-NETWATCH */
/**
 * 観測 1 件を集計に反映する。 DNS 応答は名前の対応として覚え、 通信先にはその時点で
 * 分かっているドメイン (SNI / Host、 無ければ DNS 応答で覚えた名前) を付ける。
 */

import type { DnsAnswerCache } from './dns-answer-cache.js';
import type { DestinationStore } from './destination-store.js';
import type { Destination, PacketObservation } from './types.js';

export interface IngestCounters {
  /** 公開アドレス宛ての観測数。 */
  publicObserved: number;
  /** そのうち国が付かなかった数 (GeoIP 未設定の手がかり)。 */
  publicWithoutCountry: number;
}

export class ObservationIngest {
  readonly counters: IngestCounters = { publicObserved: 0, publicWithoutCountry: 0 };

  constructor(private readonly dns: DnsAnswerCache, private readonly store: DestinationStore) {}

  apply(observation: PacketObservation): Destination | null {
    if (observation.dns) this.dns.record(observation.dns, observation.atMs);
    const domains = observation.serverName
      ? [observation.serverName]
      : observation.kind === 'dns'
        ? []
        : this.dns.namesFor(observation.remote, observation.atMs);
    const destination = this.store.hit({
      remote: observation.remote,
      atMs: observation.atMs,
      kind: observation.kind,
      port: observation.port,
      country: observation.country,
      domains,
    });
    if (destination?.scope === 'public') {
      this.counters.publicObserved += 1;
      if (!observation.country) this.counters.publicWithoutCountry += 1;
    }
    return destination;
  }

  resetCounters(): void {
    this.counters.publicObserved = 0;
    this.counters.publicWithoutCountry = 0;
  }
}
