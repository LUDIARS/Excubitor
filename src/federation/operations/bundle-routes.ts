/**
 * 外部に出られない拠点へ repo の main を git bundle で渡す公開面 (相互登録済みのピアだけ)。
 *
 *   GET /api/v1/federation/git/bundle?repo=<owner/name>&have=<相手の HEAD>
 *     200 application/octet-stream = bundle / 204 = 相手が最新 / 404 = この拠点にその repo が無い
 */

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Catalog } from '../../catalog/loader.js';
import type { FederationEnv } from '../peer-auth.js';
import { createMainBundle, findRepoCheckout, isValidHash, isValidRepoName } from './bundle-server.js';

/** @implements SPEC-FEDERATION-MESH-SOURCE */

export function buildBundleRoutes(getCatalog: () => Catalog, auth: MiddlewareHandler<FederationEnv>): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();

  app.get('/api/v1/federation/git/bundle', auth, async (c) => {
    const repo = c.req.query('repo') ?? '';
    const have = c.req.query('have') ?? null;
    if (!isValidRepoName(repo)) return c.json({ error: 'invalid_repo' }, 400);
    if (have !== null && !isValidHash(have)) return c.json({ error: 'invalid_have' }, 400);
    const dir = await findRepoCheckout(getCatalog(), repo);
    if (!dir) return c.json({ error: 'repo_not_found_on_this_node' }, 404);
    const bundle = await createMainBundle(dir, have);
    if (bundle.kind === 'up_to_date') return c.body(null, 204);
    if (bundle.kind === 'error') return c.json({ error: bundle.error }, bundle.status);
    const stream = createReadStream(bundle.path);
    // 送り終えた (または切断された) ら一時ファイルを消す。
    stream.once('close', () => void bundle.cleanup());
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  });

  return app;
}
