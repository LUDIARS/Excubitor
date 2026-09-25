/** Background materialization; request handlers never call this collector. */
import type { Catalog } from '../catalog/loader.js';
import { readProjectView } from '../launch/router.js';
import { getLaunchProfile } from '../launch/profile.js';
import { getHealthCache } from '../scanner/health-cache.js';
import { localNodeName } from '../federation/node-snapshot.js';
import { listEnabledPeerIdentities } from '../federation/store.js';
import { getPeerState } from '../federation/peer-cache.js';
import { federationSettings } from '../federation/settings.js';
import { groupOverviewServices, type ServiceOverview, type OverviewSite } from './model.js';
/** @implements SPEC-EX-SERVICE-OVERVIEW */
export async function collectOverview(catalog: Catalog, now: number): Promise<ServiceOverview> {
  const projects = await readProjectView(catalog);
  const health = getHealthCache();
  const profile = getLaunchProfile();
  const startup = new Set(profile.autoLaunch ? profile.selection : []);
  const staleAfter = Math.max(90_000, (health.intervalMs ?? 60_000) * 3);
  const sites: OverviewSite[] = [{
    id: 'local', name: localNodeName(), local: true, connected: true,
    stale: health.completedAt === null || now - health.completedAt > staleAfter,
    checked_at: health.completedAt,
    services: groupOverviewServices(projects.flatMap(p => p.components.map(c => {
      const h = health.services.get(c.code);
      return {
        project: p.project_code, code: c.code, name: c.name,
        state: h?.ok ? 'up' as const : 'down' as const,
        observed: !!h && h.reason !== 'not_configured', checked_at: h?.checkedAt ?? null,
        version: h?.reportedVersion ?? c.package_version,
        startup: profile.configured ? startup.has(c.code) : !!c.autostart,
        subdomain: c.subdomain ?? null, frontend_url: c.frontend_url ?? null, disabled: !!c.disabled,
      };
    }))),
  }];
  for (const peer of listEnabledPeerIdentities()) {
    const state = getPeerState(peer.id);
    const payload = state?.payload;
    const checkedAt = payload?.scan.completed_at ?? null;
    sites.push({
      id: peer.id, name: payload?.node ?? peer.name, local: false,
      connected: state?.status === 'up',
      stale: !checkedAt || now - checkedAt > federationSettings(catalog).staleAfterMs,
      checked_at: checkedAt,
      services: groupOverviewServices((payload?.services ?? []).map(c => ({
        project: c.project_code ?? c.code, code: c.code, name: c.name,
        state: c.health.state === 'up' ? 'up' as const : 'down' as const,
        observed: c.health.state === 'up' || c.health.state === 'down', checked_at: c.health.checked_at,
        version: c.health.reported_version, startup: c.startup ?? null,
        subdomain: null, frontend_url: null, disabled: false,
      }))),
    });
  }
  return { generated_at: now, stale_after_ms: staleAfter, sites };
}
