/**
 * Requester side: operations this site's administrator sent to a peer and the peer accepted.
 * Only these can be reauthorized later, with exactly the recorded scope. Memory only: a
 * requester restart drops them, and the queued operation then fails with a reason.
 *
 * @implements SPEC-SECURITY-MESH-REAUTHORIZATION
 */

import type { ReauthorizationScope } from '../security/reauthorization.js';

export const OUTBOUND_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_APPROVALS = 1000;

interface Approval extends ReauthorizationScope { peerId: string; expiresAt: number }

const approvals = new Map<string, Approval>();
const keyOf = (peerId: string, operationId: string): string => JSON.stringify([peerId, operationId]);

export function recordOutboundApproval(peerId: string, scope: ReauthorizationScope, now = Date.now()): void {
  for (const [key, approval] of approvals) if (approval.expiresAt <= now) approvals.delete(key);
  if (approvals.size >= MAX_APPROVALS) approvals.delete(approvals.keys().next().value as string);
  approvals.set(keyOf(peerId, scope.operationId), { ...scope, peerId, expiresAt: now + OUTBOUND_APPROVAL_TTL_MS });
}

/** Pure scope comparison: any difference (action, resource, digest) is a different operation. */
export function matchesApproval(approval: ReauthorizationScope, requested: ReauthorizationScope): boolean {
  return approval.operationId === requested.operationId && approval.action === requested.action &&
    approval.resource === requested.resource && approval.requestDigest === requested.requestDigest;
}

/** Single use: a matching approval is consumed so one approval yields one execution token. */
export function takeOutboundApproval(peerId: string, requested: ReauthorizationScope, now = Date.now()): boolean {
  const key = keyOf(peerId, requested.operationId);
  const approval = approvals.get(key);
  if (!approval || approval.expiresAt <= now || approval.peerId !== peerId || !matchesApproval(approval, requested)) return false;
  approvals.delete(key);
  return true;
}

export function clearOutboundApprovals(): void { approvals.clear(); }
