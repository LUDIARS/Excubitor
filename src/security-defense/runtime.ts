import { Hono } from 'hono';
import { z } from 'zod';
import type { Catalog } from '../catalog/loader.js';
import type { NetwatchSnapshot } from '../netwatch/runtime.js';
import type { AccessEvidence } from '../intrusion/detection.js';
import type { AccessDecision } from '../intrusion/decision.js';
import { createNamedLogger } from '../shared/logger.js';
import { sendDiscordWebhook } from '../notify/discord-webhook.js';
import { readDefenseConfig, defenseConfigSchema } from './config.js';
import { RequestPolicy } from './request-policy.js';
import { DefenseStore } from './store.js';
import { Baseline } from './baseline.js';
import { HostObserver } from './host-observer.js';
import { reportDay, jstDay } from './dates.js';
import { deliverDaily } from './daily-delivery.js';

const logger = createNamedLogger('excubitor.security-defense');
const approval = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().trim().min(1).max(500) }).strict();
export interface DefenseRuntime {
  router: Hono;
  policy: RequestPolicy;
  evidence(event: AccessEvidence, status: number, decision?: AccessDecision): void;
  logFailure(): void;
  stop(): Promise<void>;
}

/** Owns the timer/database and awaits in-flight collection and delivery before closing. */
export function startDefenseRuntime(catalog: Catalog, site: string, webhook: string,
  network?: () => NetwatchSnapshot, now: () => number = Date.now, serviceCodes: readonly string[] = []): DefenseRuntime {
  const configured = readDefenseConfig();
  const config = defenseConfigSchema.parse({ ...configured, services: [
    ...configured.services,
    ...[...new Set(serviceCodes)].filter(code => !configured.services.some(s => s.service === code)).map(service => ({ service })),
  ] });
  const store = new DefenseStore('data/security-defense.sqlite');
  try {
  const baseline = new Baseline(store);
  const host = new HostObserver(store, baseline, catalog, config.watchPaths, network, now());
  const policy = new RequestPolicy(config, new Set(configured.services.map(s => s.service)));
  const router = new Hono();
  let lastSample: number | null = null;
  let state = 'starting';
  let work: Promise<void> | null = null;
  let stopped = false;
  const startedAt = now();
  const firstObserved = store.state('first_observed') ?? String(startedAt);
  store.setState('first_observed', firstObserved);
  store.coverage(startedAt, 'runtime', 'startup_partial_day');
  async function tick(): Promise<void> {
    const at = now();
    if (lastSample === null || at - lastSample >= 300000) {
      const previous = Number(store.state('last_sample'));
      if (previous && at - previous > 600000) store.coverage(at, 'runtime', 'observation_gap');
      await host.sample(at);
      lastSample = at;
      store.setState('last_sample', String(at));
      store.coverage(at, 'runtime', 'healthy');
      store.coverage(at, 'authentication_routes', config.services.some(s => s.authPaths.length) ? 'partially_configured' : 'unconfigured');
    }
    const day = reportDay(at, config.dailyHourJst);
    if (day && day >= jstDay(Number(firstObserved))) {
      const result = await deliverDaily(store, day, site, at, message => sendDiscordWebhook(webhook, message));
      if (result === 'unknown') logger.warn('security daily delivery is uncertain; retained locally without automatic resend');
    }
    store.prune(at);
    state = 'running';
  }
  function schedule(): void {
    if (stopped || work) return;
    work = tick().catch(() => {
      state = 'failed';
      logger.warn('security defense collection or persistence failed; coverage is incomplete');
    }).finally(() => { work = null; });
  }
  const timer = setInterval(schedule, 60000);
  timer.unref();
  schedule();
  router.get('/api/v1/intrusion/defense', c => c.json({ state, mode: config.mode, site, lastSample,
    dailyHourJst: config.dailyHourJst, baseline: baseline.status(),
    configuredServices: config.services.map(s => ({ service: s.service, authRoutes: s.authPaths.length })),
    coverage: store.data(jstDay(now())).coverage,
    limits: ['local-host-only', 'periodic-observation', 'no-cf-edge-logs', 'not-a-compromise-verdict'] }));
  router.get('/api/v1/intrusion/defense/reports', c => c.json({ reports: store.reports().map(r => ({ day: r.day, delivery: r.delivery, report: JSON.parse(r.body) as unknown })) }));
  router.get('/api/v1/intrusion/defense/network', c => {
    const day = c.req.query('day') ?? jstDay(now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
      return c.json({ error: 'invalid_day' }, 400);
    }
    return c.json({ day, network: store.networkRows(day), coverage: store.data(day).coverage.filter(row => row.source === 'network_evidence'),
      limitations: ['historical-hashes-cannot-be-reversed', 'periodic-snapshot-attribution-not-per-packet'] });
  });
  // Existing management browser/access guard applies. Local paths never enter daily notifications.
  router.get('/api/v1/intrusion/defense/baseline/candidate', c => c.json({ candidate: baseline.review() }));
  router.post('/api/v1/intrusion/defense/baseline/approve', async c => {
    const parsed = approval.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_baseline_approval' }, 400);
    if (!baseline.approve(parsed.data.digest, parsed.data.note, now())) return c.json({ error: 'stale_or_incomplete_candidate' }, 409);
    return c.json({ approved: true, digest: parsed.data.digest });
  });
  return { router, policy,
    logFailure: () => { store.coverage(now(), 'gateway_evidence', 'failed'); },
    evidence: (event, status, decision) => {
      store.count(event.at, event.service, decision?.reason ?? 'unknown', decision?.action ?? 'unknown', status);
    },
    stop: async () => { stopped = true; clearInterval(timer); try { await work; } finally { store.close(); } },
  };
  } catch (error) { store.close(); throw error; }
}
