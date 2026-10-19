/**
 * Requester side public route (mesh listener):
 *
 *   POST /api/v1/federation/operations/reauthorize
 *     A receiver whose queued operation outlived its token asks for a fresh execution token.
 *     Answered only for an operation this site sent and the receiver accepted, with the same
 *     operation id / action / resource / request digest. 200 {headers} / 403 / 404 / 503.
 *
 * @implements SPEC-SECURITY-MESH-REAUTHORIZATION
 */

import { Hono, type MiddlewareHandler } from 'hono';
import type { FederationEnv } from '../peer-auth.js';
import { permitsMeshAction } from '../security/grants.js';
import { REAUTHORIZE_PATH, ReauthorizationRequestSchema, type ReauthorizationScope } from '../security/reauthorization.js';
import { issueReauthorizationHeaders } from '../security/reauthorization-issuer.js';
import { takeOutboundApproval } from './outbound-approvals.js';

export interface ReauthorizeRoutesDeps {
  auth: MiddlewareHandler<FederationEnv>;
  takeApproval?: (peerId: string, scope: ReauthorizationScope) => boolean;
  issue?: (peerId: string, scope: ReauthorizationScope) => Promise<Record<string, string>>;
}

export function buildReauthorizeRoutes(deps: ReauthorizeRoutesDeps): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();
  const takeApproval = deps.takeApproval ?? ((peerId, scope) => takeOutboundApproval(peerId, scope));
  const issue = deps.issue ?? issueReauthorizationHeaders;

  app.post(REAUTHORIZE_PATH, deps.auth, async (c) => {
    const caller = c.get('federationCaller');
    // The asking receiver must itself be an authenticated Cr workload of a registered peer.
    if (caller.authMode !== 'cr-v1' || !permitsMeshAction({ caller, action: 'monitor', resource: `node:${caller.audience}` })) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = ReauthorizationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const scope: ReauthorizationScope = {
      operationId: parsed.data.operation_id, action: parsed.data.action,
      resource: parsed.data.resource, requestDigest: parsed.data.request_digest,
    };
    if (!takeApproval(caller.peerId, scope)) return c.json({ error: 'approval_not_found' }, 404);
    try {
      return c.json({ headers: await issue(caller.peerId, scope) });
    } catch {
      // Cr refusal or outage: no fallback token. The receiver fails the operation with a reason.
      return c.json({ error: 'reauthorization_unavailable' }, 503);
    }
  });

  return app;
}
