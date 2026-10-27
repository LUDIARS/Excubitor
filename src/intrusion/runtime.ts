import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { currentAllowlist } from '../cf-tunnel/broker-support.js';
import { CloudflareTunnelApi } from '../cf-tunnel/cloudflare-api.js';
import { resolveCfCredentials } from '../cf-tunnel/credentials.js';
import { sharedVault } from '../vault/vault.js';
import { normalizeDiscordWebhookUrl } from '../notify/discord-webhook.js';
import { createNamedLogger } from '../shared/logger.js';
import { sharedLogsRoot } from '../log/logs-root.js';
import { readIntrusionConfig } from './config.js';
import { IntrusionStore } from './store.js';
import { IntrusionMonitor } from './monitor.js';
import { RequestFilter } from './request-filter.js';
import { accessEvidenceWriter } from './evidence-log.js';
import { containTunnels } from './containment.js';
import { reportIncident, reportRequestDenial } from './discord.js';
import { startIntrusionGateway } from './gateway.js';
import { verifyCoverage } from './coverage.js';
import { installIntrusionRouteGuard } from './route-guard.js';
import { validateOriginTargets } from './origin-policy.js';
import { verifyExistingOrigins } from './origin-adoption.js';
import { OriginApprovals } from './origin-approvals.js';

const logger = createNamedLogger('excubitor.intrusion');
export interface IntrusionRuntime { router: Hono; stop(): Promise<void> }

/** Owns gateway, state store and retry timer; unconfigured is explicit and inert. */
export async function startIntrusionRuntime(catalog: Catalog): Promise<IntrusionRuntime> {
  const router = new Hono();
  const config = readIntrusionConfig();
  if (!config) {
    router.get('/api/v1/intrusion', c => c.json({ state: 'unconfigured', coverage: 'unverified' }));
    return { router, stop: async () => {} }; // Explicit absence, not a simulated protected mode.
  }
  const self = catalog.services.find(service => service.code === 'excubitor');
  const port = self?.ports?.find(entry => entry.role === 'public-ingress')?.port;
  if (!port) throw new Error('public-ingress port is missing from Excubitor catalog');
  const managementKeys = validateOriginTargets(catalog, config, port);
  const allowed = currentAllowlist();
  if (config.routes.some(route => !allowed.includes(route.hostname))) throw new Error('intrusion hostname outside CF allowlist');
  // Credentials stay inside Ex; no request path, status API, spec or log receives them.
  const creds = await resolveCfCredentials();
  const values = await sharedVault().valuesOf(['EXCUBITOR_SECURITY_DISCORD_WEBHOOK']);
  const webhook = normalizeDiscordWebhookUrl(values.EXCUBITOR_SECURITY_DISCORD_WEBHOOK ?? '');
  await verifyExistingOrigins(new CloudflareTunnelApi(creds, AbortSignal.timeout(30_000)), config, port,
    new OriginApprovals('data/intrusion-origin-approvals.json'), managementKeys);
  const store = new IntrusionStore('data/intrusion.sqlite');
  const requestFiltering = config.enforcement === 'request-filter';
  let monitor: IntrusionMonitor | RequestFilter | null = null;
  let gateway: Awaited<ReturnType<typeof startIntrusionGateway>> | null = null;
  let releaseRouteGuard: (() => void) | null = null;
  try {
    const unclean = store.wasRunning();
    const writeEvidence = accessEvidenceWriter(sharedLogsRoot());
    monitor = requestFiltering ? new RequestFilter(config, {
      evidence: writeEvidence,
      notifyDenied: (event, reason) => reportRequestDenial(webhook, config.site, event, reason),
      warn: message => logger.warn(message), now: Date.now,
    }) : new IntrusionMonitor(config, {
      load: () => store.read(), save: incident => store.save(incident),
      evidence: writeEvidence,
      contain: () => containTunnels(new CloudflareTunnelApi(creds, AbortSignal.timeout(15_000)), config, currentAllowlist(),
        (id, before) => store.saveTunnelSnapshot(id, before)),
      notify: incident => reportIncident(webhook, incident),
      closePublicConnections: () => gateway?.closeConnections(),
      warn: message => logger.warn(message), now: Date.now,
    });
    // Keep lifecycle evidence in both policies. Only legacy site-cutoff converts
    // an unclean restart into a global latch; request-filter never rewrites CF.
    store.markRunning(true);
    if (unclean && monitor instanceof IntrusionMonitor) monitor.trip({ service: 'excubitor', at: Date.now() }, 'unclean_restart');
    if (unclean && requestFiltering) logger.warn('unclean restart recorded; request filtering remains active without site cutoff');
    gateway = await startIntrusionGateway(config, port, monitor);
    monitor.start();
    const activeMonitor = monitor;
    const activeGateway = gateway;
    releaseRouteGuard = installIntrusionRouteGuard(config.routes.map(route => route.hostname),
      `http://127.0.0.1:${port}`, () => activeMonitor.status().state === 'blocked');
    router.get('/api/v1/intrusion', c => c.json({ ...activeMonitor.status(), site: config.site,
      enforcement: config.enforcement ?? 'site-cutoff',
      previousIncident: requestFiltering ? store.read() : undefined,
      coverage: 'unverified', configuredHostnames: config.routes.map(route => route.hostname) }));
    router.post('/api/v1/intrusion/verify', async c => {
      try {
        const api = new CloudflareTunnelApi(creds, AbortSignal.timeout(30_000));
        await verifyExistingOrigins(api, config, port, new OriginApprovals('data/intrusion-origin-approvals.json'), managementKeys, false);
        return c.json(await verifyCoverage(api, config, port));
      } catch { return c.json({ state: 'unverified', error: 'coverage_verification_failed' }, 502); }
    });
    return { router, stop: async () => {
      try {
        try { await activeGateway.close(); }
        finally { await activeMonitor.stop(); }
        if (!activeMonitor.status().incident) store.markRunning(false);
      } finally { releaseRouteGuard?.(); store.close(); }
    } };
  } catch (error) {
    try { await gateway?.close(); await monitor?.stop(); }
    finally { releaseRouteGuard?.(); store.close(); }
    throw error;
  }
}
