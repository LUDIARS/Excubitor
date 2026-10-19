/**
 * Cr grant scope of a federation operation (pure). Shared by the requester (token issue),
 * the receiver (grant check) and queued-operation reauthorization so the scope cannot drift.
 *
 * @implements SPEC-SECURITY-MESH-CR-AUTH
 */

export interface OperationScope { action: string; resource: string }

export function operationScope(request: {
  action: string;
  target: { kind: 'service'; code: string } | { kind: 'excubitor' };
}): OperationScope {
  return {
    action: request.action === 'concordia-federation-site' ? 'hq-config' : `operation:${request.action}`,
    resource: `service:${request.target.kind === 'service' ? request.target.code : 'excubitor'}`,
  };
}
