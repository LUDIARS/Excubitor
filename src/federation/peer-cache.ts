/**
 * 他拠点へ問い合わせた結果のキャッシュ (メモリ)。
 *
 * peer-poller.ts が周期的に書き、 集約ビュー / 自拠点の health 応答 (links) はここを読むだけ。
 * 画面やツールが何度開かれても、 他拠点へ飛ぶ通信は poller の周期ぶんだけで済む。
 *
 * 失敗したときも直前に取れた payload は残す (stale として表示できるように)。
 */

import type { NodeHealthPayload, NodePeerLink, PeerLinkStatus } from './health-types.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

export interface PeerPollState {
  peer_id: string;
  /** ピア登録名。 */
  name: string;
  status: PeerLinkStatus;
  latency_ms: number | null;
  checked_at: number | null;
  last_ok_at: number | null;
  error: string | null;
  /** 直近に取得できた相手の health。 取得に失敗しても前回分を残す。 */
  payload: NodeHealthPayload | null;
  payload_received_at: number | null;
}

export interface PeerPollOutcome {
  ok: boolean;
  status: PeerLinkStatus;
  latency_ms: number | null;
  error: string | null;
  payload: NodeHealthPayload | null;
}

const states = new Map<string, PeerPollState>();

/** 1 回の問い合わせ結果を反映する。 */
export function recordPeerPoll(peer: { id: string; name: string }, outcome: PeerPollOutcome, now: number): PeerPollState {
  const previous = states.get(peer.id);
  const next: PeerPollState = {
    peer_id: peer.id,
    name: peer.name,
    status: outcome.status,
    latency_ms: outcome.latency_ms,
    checked_at: now,
    last_ok_at: outcome.ok ? now : previous?.last_ok_at ?? null,
    error: outcome.error,
    payload: outcome.payload ?? previous?.payload ?? null,
    payload_received_at: outcome.payload ? now : previous?.payload_received_at ?? null,
  };
  states.set(peer.id, next);
  return next;
}

/** 登録直後でまだ問い合わせていないピアの状態。 */
export function pendingPeerState(peer: { id: string; name: string }): PeerPollState {
  return {
    peer_id: peer.id,
    name: peer.name,
    status: 'pending',
    latency_ms: null,
    checked_at: null,
    last_ok_at: null,
    error: null,
    payload: null,
    payload_received_at: null,
  };
}

export function getPeerState(peerId: string): PeerPollState | null {
  return states.get(peerId) ?? null;
}

/** 有効なピアの一覧に無くなったもの (削除 / 無効化) を捨てる。 */
export function prunePeerStates(activePeerIds: ReadonlySet<string>): void {
  for (const id of states.keys()) {
    if (!activePeerIds.has(id)) states.delete(id);
  }
}

/** ピア状態を「自拠点から相手へのつながり」として表す (pure)。 */
export function toPeerLink(state: PeerPollState): NodePeerLink {
  return {
    node: state.payload?.node ?? state.name,
    status: state.status,
    latency_ms: state.latency_ms,
    checked_at: state.checked_at,
    last_ok_at: state.last_ok_at,
    error: state.error,
  };
}

/** テスト用。 */
export function clearPeerStates(): void {
  states.clear();
}
