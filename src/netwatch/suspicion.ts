/** @implements SPEC-EX-NETWATCH */
/**
 * 通信先を「サービスの通信か」「怪しいか」で判定する。 国外であることだけでは怪しいとしない
 * (開発で使う通信の大半は国外のため)。 判定は表示と API のためだけで、 通信は止めない。
 */

import type { AssessedDestination, Destination, DestinationAssessment, SuspicionReason } from './types.js';

export interface SuspicionPolicy {
  /** 怪しいとしない宛先ポート。 */
  allowedPorts: ReadonlySet<number>;
  /** 怪しいとしないドメイン (そのドメインと配下)。 小文字。 */
  trustedDomains: readonly string[];
}

/** 通信したプロセスがすべてサービスなら、 その code。 1 つでもサービス以外か、 不明なら空。 */
function serviceCodes(destination: Destination): string[] {
  if (destination.owners.length === 0) return [];
  const codes = destination.owners.map((owner) => owner.service);
  if (codes.some((code) => code === null)) return [];
  return [...new Set(codes as string[])];
}

function isTrusted(domains: readonly string[], trusted: readonly string[]): boolean {
  return domains.some((domain) => trusted.some((base) => domain === base || domain.endsWith(`.${base}`)));
}

function reasonsFor(destination: Destination, policy: SuspicionPolicy): SuspicionReason[] {
  if (destination.scope !== 'public') return [];
  // DNS 応答だけで知った宛先 (= DNS サーバ) は、 この PC が名前を引きに行った先なので判定しない。
  if (destination.kinds.every((kind) => kind === 'dns')) return [];
  if (isTrusted(destination.domains, policy.trustedDomains)) return [];
  const reasons: SuspicionReason[] = [];
  // DNS で引いた形跡も SNI / Host も無い = アドレスを直に指定してつないだ。
  if (destination.domains.length === 0) reasons.push('direct-ip');
  if (destination.ports.some((port) => !policy.allowedPorts.has(port))) reasons.push('unusual-port');
  return reasons;
}

export function assessDestination(destination: Destination, policy: SuspicionPolicy): DestinationAssessment {
  const services = serviceCodes(destination);
  return { services, reasons: services.length > 0 ? [] : reasonsFor(destination, policy) };
}

export function assessDestinations(destinations: readonly Destination[], policy: SuspicionPolicy): AssessedDestination[] {
  return destinations.map((destination) => ({ ...destination, assessment: assessDestination(destination, policy) }));
}

/** 一覧と API に出す理由の短い言葉。 */
export const SUSPICION_LABELS: Record<SuspicionReason, string> = {
  'direct-ip': 'IP直接',
  'unusual-port': '許可外ポート',
};
