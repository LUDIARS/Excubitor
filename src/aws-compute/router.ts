import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AwsCredentialSource } from './credentials.js';
import type { JobJournal } from './job-journal.js';
import { toJobReceipt } from './job-receipt.js';
import { isAwsComputeLoopback } from './loopback.js';
import type { OrphanSweep } from './orphan-sweep.js';
import type { ComputeRegistry } from './registry.js';
import { computeTargetSchema, submitJobSchema } from './target-schema.js';

interface RouterDeps {
  registry: ComputeRegistry;
  journal: JobJournal;
  credentials: Pick<AwsCredentialSource, 'readiness'>;
  sweep: Pick<OrphanSweep, 'report'>;
  allowLaunch: () => boolean;
  isLoopback?: (context: Context) => boolean;
  now?: () => number;
}

const listQuery = z.object({
  active: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export function buildAwsComputeRouter(deps: RouterDeps): Hono {
  const app = new Hono();
  const isLoopback = deps.isLoopback ?? isAwsComputeLoopback;
  const now = deps.now ?? Date.now;
  app.use('*', async (context, next) => {
    if (!isLoopback(context)) return context.json({ error: 'loopback_required' }, 403);
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  app.onError((_error, context) => context.json({ error: 'aws_compute_internal_error' }, 500));

  app.get('/targets', async (c) => c.json({
    targets: deps.registry.list(),
    owner: deps.registry.owner(),
    credentials: await deps.credentials.readiness(),
  }));

  app.put('/targets/:id', async (c) => {
    const parsed = computeTargetSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_target', fields: parsed.error.issues.map(({ path }) => path.join('.')) }, 400);
    }
    if (parsed.data.id !== c.req.param('id')) return c.json({ error: 'target_id_mismatch' }, 400);
    const outcome = deps.registry.put(parsed.data);
    return outcome === 'saved' ? c.json({ target: parsed.data }) : c.json({ error: outcome }, 409);
  });

  app.delete('/targets/:id', (c) => {
    const outcome = deps.registry.delete(c.req.param('id'));
    if (outcome === 'deleted') return c.body(null, 204);
    return c.json({ error: outcome }, outcome === 'target_busy' ? 409 : 404);
  });

  app.get('/orphans', (c) => c.json({ sweep: deps.sweep.report() }));

  app.post('/jobs', async (c) => {
    if (!deps.allowLaunch()) return c.json({ error: 'launch_disabled' }, 503);
    const parsed = submitJobSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_job' }, 400);
    const readiness = await deps.credentials.readiness();
    const reservation = deps.journal.reserve(parsed.data, now(), readiness.configured);
    if ('job' in reservation) return c.json(toJobReceipt(reservation.job), reservation.created ? 202 : 200);
    const { error } = reservation;
    if (error === 'credentials_unavailable') return c.json({ error }, 503);
    if (error === 'runner_not_found' || error === 'target_not_found') return c.json({ error }, 404);
    if (error === 'target_busy' || error === 'job_conflict') return c.json({ error }, 409);
    return c.json({ error }, 400);
  });

  app.get('/jobs', (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_query' }, 400);
    const { active, limit, offset } = query.data;
    return c.json({ jobs: deps.journal.list(active === 'true', limit, offset).map(toJobReceipt) });
  });

  app.get('/jobs/:id', (c) => {
    const job = deps.journal.get(c.req.param('id'));
    return job ? c.json(toJobReceipt(job)) : c.json({ error: 'job_not_found' }, 404);
  });

  app.post('/jobs/:id/cancel', (c) => {
    const job = deps.journal.requestStop(c.req.param('id'), now());
    if (!job) return c.json({ error: 'job_not_found' }, 404);
    return c.json(toJobReceipt(job), job.release === 'requested' ? 202 : 200);
  });
  return app;
}
