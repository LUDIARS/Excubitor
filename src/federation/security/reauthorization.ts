import { z } from 'zod';
import type { OperationScope } from './operation-scope.js';

/**
 * Queued-operation reauthorization (pure parts).
 *
 * A queued remote operation outlives its Cr token (TTL <= 60s). Right before execution the
 * receiver asks the requester to re-obtain authorization for exactly the same operation id,
 * action, resource and request digest. The requester only answers for an operation its
 * administrator approved, and obtains a fresh token from Cr (Cr re-checks the grant). The
 * receiver verifies that token + proof like any mesh request. Scope never changes.
 *
 * @implements SPEC-SECURITY-MESH-REAUTHORIZATION
 */

export const REAUTHORIZE_PATH = '/api/v1/federation/operations/reauthorize';

export interface ReauthorizationScope extends OperationScope {
  operationId: string;
  requestDigest: string;
}

export const ReauthorizationRequestSchema = z.object({
  operation_id: z.string().min(1).max(100),
  action: z.string().min(1).max(100),
  resource: z.string().min(1).max(400),
  request_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const ReauthorizationResponseSchema = z.object({
  headers: z.record(z.string().max(33_000)),
}).strict();

export function reauthorizationRequest(scope: ReauthorizationScope): z.infer<typeof ReauthorizationRequestSchema> {
  return { operation_id: scope.operationId, action: scope.action, resource: scope.resource, request_digest: scope.requestDigest };
}

/** The signed pseudo request that binds the fresh token to this one execution. */
export function executionProofTarget(scope: ReauthorizationScope): { method: 'POST'; path: string; body: string } {
  return {
    method: 'POST',
    path: `/api/v1/federation/operations/${encodeURIComponent(scope.operationId)}/execute`,
    body: JSON.stringify(['excubitor-execute-v1', scope.operationId, scope.action, scope.resource, scope.requestDigest]),
  };
}

export type PermitCheck = { ok: true } | { ok: false; reason: string };

/**
 * - recheck: the token captured at acceptance is still valid; introspect it again.
 * - reacquire: the token expired while queued, or the in-memory permit was lost (restart).
 */
export function planPermitCheck(permit: { expiresAt: number } | undefined, now: number): 'recheck' | 'reacquire' {
  return permit && permit.expiresAt > now ? 'recheck' : 'reacquire';
}
