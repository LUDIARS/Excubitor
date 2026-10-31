/** @implements SPEC-EX-NETWATCH */
/**
 * 通信先の集計を Tela の一覧 (ListView) に変える。 サービス (Excubitor が起動したもの) の通信は出さない。
 * 怪しいもの → 国外 → その他の順に並べ、 怪しいもの・国外を alert、 国不明を muted にする。
 */

import type { AttributionStatus } from './connection-poller.js';
import { SUSPICION_LABELS } from './suspicion.js';
import type { AssessedDestination, CaptureStatus, TrafficOwner } from './types.js';
import { MAX_LIST_ROWS, type ListRow, type ListView, type RowMark } from './tela-list-format.js';

export interface NetwatchListOptions {
  maxRows: number;
  /** 'foreign' は怪しいものと国外だけ、 'public' は公開アドレス全部。 */
  include: 'foreign' | 'public';
  formatTime: (ms: number) => string;
}

interface ListCounts {
  suspicious: number;
  foreign: number;
  services: number;
}

function attributionNote(attribution: AttributionStatus): string {
  if (attribution.state === 'failed' || attribution.state === 'unsupported') {
    return ` / 送信元不明 (${attribution.reason ?? attribution.state})`;
  }
  return '';
}

function statusLine(status: CaptureStatus, attribution: AttributionStatus, counts: ListCounts): string {
  if (status.state !== 'running') {
    return `capture ${status.state}${status.reason ? `: ${status.reason}` : ''}`;
  }
  const geoip = status.publicObserved > 0 && status.publicWithoutCountry === status.publicObserved
    ? ' / GeoIP 未設定? (国が 1 件も付いていない)'
    : '';
  return `怪しい ${counts.suspicious} 件 / 国外 ${counts.foreign} 件 (サービス ${counts.services} 件を除外)`
    + `${geoip}${attributionNote(attribution)}`;
}

function ownerLabel(owners: readonly TrafficOwner[]): string {
  const [first, ...rest] = owners;
  if (!first) return '?';
  const name = first.name ?? `pid ${first.pid}`;
  return rest.length > 0 ? `${name} +${rest.length}` : name;
}

function verdict(destination: AssessedDestination): string {
  const { reasons } = destination.assessment;
  if (reasons.length > 0) return reasons.map((reason) => SUSPICION_LABELS[reason]).join('/');
  if (destination.locality === 'foreign') return '国外';
  return '-';
}

function rowFor(destination: AssessedDestination, formatTime: NetwatchListOptions['formatTime']): ListRow {
  const suspicious = destination.assessment.reasons.length > 0;
  const mark: RowMark = suspicious || destination.locality === 'foreign' ? 'alert'
    : destination.locality === 'unknown' ? 'muted' : 'normal';
  const domain = destination.domains[0] ?? '(ドメイン不明)';
  const port = destination.ports[0];
  const remote = destination.remote.includes(':') ? `[${destination.remote}]` : destination.remote;
  return {
    mark,
    columns: [
      verdict(destination),
      destination.country ?? '??',
      ownerLabel(destination.owners),
      domain,
      port ? `${remote}:${port}` : remote,
      formatTime(destination.lastSeenMs),
    ],
  };
}

/** 通信先の集計から一覧を作る。 グループの中は最後に見た時刻の新しい順。 */
export function netwatchListView(
  destinations: readonly AssessedDestination[],
  status: CaptureStatus,
  attribution: AttributionStatus,
  options: NetwatchListOptions,
): ListView {
  const publicOnes = destinations.filter((destination) => destination.scope === 'public');
  const services = publicOnes.filter((destination) => destination.assessment.services.length > 0);
  const watched = publicOnes.filter((destination) => destination.assessment.services.length === 0);
  const suspicious = watched.filter((destination) => destination.assessment.reasons.length > 0);
  const foreign = watched.filter((destination) =>
    destination.assessment.reasons.length === 0 && destination.locality === 'foreign');
  const others = options.include === 'public'
    ? watched.filter((destination) => destination.assessment.reasons.length === 0 && destination.locality !== 'foreign')
    : [];
  const byRecent = (a: AssessedDestination, b: AssessedDestination): number => b.lastSeenMs - a.lastSeenMs;
  const rows = [...suspicious.sort(byRecent), ...foreign.sort(byRecent), ...others.sort(byRecent)]
    .slice(0, Math.min(options.maxRows, MAX_LIST_ROWS))
    .map((destination) => rowFor(destination, options.formatTime));
  // 国外の件数は怪しいものを含めて数える (並びでは怪しいものを先に出すだけ)。
  const foreignTotal = watched.filter((destination) => destination.locality === 'foreign').length;
  const counts = { suspicious: suspicious.length, foreign: foreignTotal, services: services.length };
  return { title: 'Excubitor 通信先', status: statusLine(status, attribution, counts), rows };
}
