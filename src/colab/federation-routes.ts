import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { FederationEnv } from '../federation/peer-auth.js';
import { readColabArtifact } from './artifacts.js';
import { allowsColabPeer } from './authorization.js';
import { colabReceipt } from './journal.js';
import { colabActions, collectSchema, jobId, MAX_REQUEST_BYTES, MESH_JOBS, submitSchema, type ColabAction } from './protocol.js';
import type { ColabRunner } from './runner.js';

export function buildColabMeshRoutes(runner: ColabRunner, auth: MiddlewareHandler<FederationEnv>): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();
  const limit = bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: c => c.json({ error: 'colab_request_too_large' }, 413) });
  const permit = (action: ColabAction): MiddlewareHandler<FederationEnv> => async (c, next) => {
    if (!allowsColabPeer({ hqPeerId: runner.site?.hqPeerId, caller: c.get('federationCaller'), action, now: Date.now() })) {
      return c.json({ error: 'colab_peer_forbidden' }, 403);
    }
    await next();
  };

  app.post(MESH_JOBS, limit, auth, permit(colabActions.submit), async c => {
    const parsed = submitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'colab_invalid_submit' }, 400);
    const result = await runner.submit(parsed.data);
    if ('error' in result) return c.json({ error: result.error }, result.status);
    return c.json(colabReceipt(result.job), result.created ? 202 : 200, { 'cache-control': 'no-store' });
  });

  app.get(`${MESH_JOBS}/:id`, auth, permit(colabActions.status), c => {
    const id = jobId.safeParse(c.req.param('id'));
    const job = id.success && runner.get(id.data);
    return job ? c.json(colabReceipt(job), 200, { 'cache-control': 'no-store' }) : c.json({ error: 'colab_job_missing' }, 404);
  });

  app.post(`${MESH_JOBS}/:id/cancel`, limit, auth, permit(colabActions.cancel), c => {
    const id = jobId.safeParse(c.req.param('id'));
    const job = id.success && runner.cancel(id.data);
    return job ? c.json(colabReceipt(job), 200, { 'cache-control': 'no-store' }) : c.json({ error: 'colab_job_missing' }, 404);
  });

  app.post(`${MESH_JOBS}/:id/collect`, limit, auth, permit(colabActions.collect), async c => {
    const id = jobId.safeParse(c.req.param('id'));
    const job = id.success && runner.get(id.data);
    if (!job) return c.json({ error: 'colab_job_missing' }, 404);
    const parsed = collectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'colab_invalid_collect' }, 400);
    if (!job.files.length) return c.json({ error: 'colab_artifacts_unavailable' }, 409);
    const { name } = parsed.data;
    if (!name) return c.json({ files: job.files }, 200, { 'cache-control': 'no-store' });
    const file = job.files.find(entry => entry.name === name);
    if (!file) return c.json({ error: 'colab_artifact_missing' }, 404);
    try {
      const bytes = await readColabArtifact(job, file);
      return new Response(new Uint8Array(bytes), { headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(file.bytes),
        'x-artifact-sha256': file.sha256,
        'cache-control': 'no-store',
      } });
    } catch {
      return c.json({ error: 'colab_artifact_unavailable' }, 503);
    }
  });
  return app;
}
