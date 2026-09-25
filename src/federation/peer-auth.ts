/**
 * 他拠点向け公開面の認可: 「相手が自分の token を知っている」 かつ 「自分が相手を登録している」。
 *
 * 1. Bearer が本拠点の agent token であること (呼び出し側がこちらを登録している証拠)
 * 2. 署名 (request-signature.ts) を、 本拠点が登録済みで有効なピアの token のどれかで検証できること
 *    (本拠点が呼び出し側を登録している証拠)。 検証できたピアが呼び出し元として後段に渡る
 * 3. 時刻窓の内側で、 nonce が未使用であること (再送の拒否)
 *
 * 応答の区別: token 違い・署名欠落・時刻ずれ・再送は 401、 署名は正しい形だが登録済みピアの
 * どれとも一致しない (= 相互登録されていない) ときは 403 `peer_not_registered`。
 */

import type { MiddlewareHandler } from 'hono';
import { verifyAgentToken } from '../secrets/agent-token.js';
import { createNonceCache } from './nonce-cache.js';
import {
  NODE_HEADER,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_MAX_SKEW_MS,
  TIMESTAMP_HEADER,
  verifyRequestSignature,
  type SignedRequestParts,
} from './request-signature.js';
import { cachedAuthenticationPeers } from './store.js';

/** @implements SPEC-FEDERATION-MUTUAL-AUTH */

/** 認可を通った呼び出し元 (本拠点の remote_peers 上の行)。 */
export interface FederationCaller {
  peerId: string;
  /** 本拠点での登録名。 */
  peerName: string;
  /** 呼び出し元が名乗った拠点名 (表示用。 認可には使わない)。 */
  claimedNode: string | null;
}

export type FederationEnv = { Variables: { federationCaller: FederationCaller } };

export interface PeerAuthDeps {
  now?: () => number;
  verifyBearer?: (authorization: string | undefined) => boolean;
  /** 検証に使う有効ピア (id / name / token)。 */
  peers?: () => Array<{ id: string; name: string; token: string; enabled: boolean }>;
}

export function requireMutualPeer(deps: PeerAuthDeps = {}): MiddlewareHandler<FederationEnv> {
  const now = deps.now ?? Date.now;
  const verifyBearer = deps.verifyBearer ?? verifyAgentToken;
  const peers = deps.peers ?? cachedAuthenticationPeers;
  const nonces = createNonceCache(SIGNATURE_MAX_SKEW_MS * 2);

  return async (c, next) => {
    if (!verifyBearer(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);

    const signature = c.req.header(SIGNATURE_HEADER);
    const nonce = c.req.header(NONCE_HEADER);
    const timestamp = Number(c.req.header(TIMESTAMP_HEADER));
    if (!signature || !nonce || !Number.isFinite(timestamp)) {
      return c.json({ error: 'signature_required' }, 401);
    }
    const current = now();
    if (Math.abs(current - timestamp) > SIGNATURE_MAX_SKEW_MS) return c.json({ error: 'stale_request' }, 401);

    const url = new URL(c.req.url);
    const parts: SignedRequestParts = {
      method: c.req.method,
      path: url.pathname + url.search,
      timestamp,
      nonce,
      // Hono は本文をキャッシュするので、 後段の c.req.json() もそのまま読める。
      body: c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text(),
    };
    const caller = peers().find((peer) => peer.enabled && peer.token && verifyRequestSignature(peer.token, parts, signature));
    if (!caller) return c.json({ error: 'peer_not_registered' }, 403);
    if (!nonces.remember(nonce, current)) return c.json({ error: 'replayed_request' }, 401);

    c.set('federationCaller', {
      peerId: caller.id,
      peerName: caller.name,
      claimedNode: decodeNodeHeader(c.req.header(NODE_HEADER)),
    });
    await next();
  };
}

function decodeNodeHeader(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value).slice(0, 100);
  } catch {
    // 壊れた percent-encoding は名乗りとして扱わない (認可には使っていないので捨てるだけ)。
    return null;
  }
}
