/**
 * 出来事を公開 / 非公開の配送先へ振り分ける (純粋関数)。
 *
 * 公開に送るのは「catalog で公開と宣言された checkout のホストコード」かつ「非公開でない依存」の出来事だけ。
 * ホストコードが checkout に対応付かないものは非公開に倒す (fail-closed)。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import type { DeliveryChannel, WatchEvent, WatchHost, WatchReport } from './types.js';

export interface HostReport {
  host: WatchHost;
  report: WatchReport | null;
}

/** watch-report.json の `host` (Ergo のホストコード) → 非公開か。 */
export function hostPrivacyByCode(reports: HostReport[]): Map<string, boolean> {
  const privacy = new Map<string, boolean>();
  for (const { host, report } of reports) {
    if (!report) continue;
    privacy.set(report.host, (privacy.get(report.host) ?? false) || host.private);
  }
  return privacy;
}

export function eventChannel(event: WatchEvent, privacy: Map<string, boolean>): DeliveryChannel {
  if (event.private) return 'private';
  return privacy.get(event.host) === false ? 'public' : 'private';
}

export function routeEvents(
  events: WatchEvent[],
  privacy: Map<string, boolean>,
): Record<DeliveryChannel, WatchEvent[]> {
  const routed: Record<DeliveryChannel, WatchEvent[]> = { public: [], private: [] };
  for (const event of events) routed[eventChannel(event, privacy)].push(event);
  return routed;
}
