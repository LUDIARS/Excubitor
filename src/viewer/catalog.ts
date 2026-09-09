import type { Catalog, Service } from '../catalog/loader.js';
import { managedPortsForService } from '../catalog/ports.js';

export interface ViewerEntry {
  code: string;
  name: string;
  href: string;
  excludedReason: string | null;
}

export interface ViewerTarget {
  code: string;
  prefix: string;
  upstream: URL;
  origins: Record<string, string>;
}

const LOOPBACK_PROJECTS = /^(actio|interpres|ludellus|manus)(?:-|$)/i;
const CORPUS_PROJECTS = /^(corpus|glab)(?:-|$)/i;
const CODE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function exclusionReason(service: Service, corpusPrefs: Map<string, boolean>): string | null {
  const identity = `${service.project_code ?? service.code}`;
  if (service.disabled) return 'Viewer対象外';
  if (/^(excubitor|ex)$/i.test(identity) || service.code === 'excubitor') return 'Ex自身はMonitorから操作';
  if (service.viewer?.loopback_required || LOOPBACK_PROJECTS.test(identity) || LOOPBACK_PROJECTS.test(service.code)) {
    return 'ループバック接続が必要';
  }
  if (CORPUS_PROJECTS.test(identity) || CORPUS_PROJECTS.test(service.code)
    || service.uses_corpus || corpusPrefs.get(service.code)
    || service.depends_on?.includes('corpus')
    || Object.keys(service.env ?? {}).some((name) => name.startsWith('CORPUS_'))) return 'Corpus系';
  if (service.runtime === 'app' || service.tier === 'local-app' || service.tier === 'infra') return 'Web画面ではありません';
  if (!CODE.test(service.code)) return 'Viewerで使用できないサービスコード';
  if (!service.frontend_url && !service.frontend_port && service.health?.type !== 'http'
    && !['frontend', 'web', 'web-api', 'server'].includes(service.component ?? '')) return 'Web入口が未登録';
  if (service.viewer?.enabled !== true) return 'Viewer対象外';
  return null;
}

function upstreamUrl(service: Service): URL | null {
  const port = service.frontend_port ?? service.port;
  if (!port || port < 1 || port > 65535) return null;
  // Only catalog-owned local ports are proxyable. Public URLs are display metadata,
  // never an arbitrary proxy destination (nor a way to bypass another site's gate).
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (service.frontend_url) {
    try {
      const declared = new URL(service.frontend_url);
      if (['127.0.0.1', 'localhost', '[::1]'].includes(declared.hostname)
        && declared.protocol === 'http:' && Number(declared.port || 80) === port) url.pathname = declared.pathname;
    } catch { return null; }
  }
  return url;
}

export function viewerEntries(catalog: Catalog, prefs: Map<string, boolean>): ViewerEntry[] {
  const entries: ViewerEntry[] = [{ code: 'villa', name: 'Villa — 資料', href: '/viewer/apps/villa/', excludedReason: null }];
  for (const service of catalog.services) {
    if (service.code === 'villa' || !CODE.test(service.code)) continue;
    const excludedReason = exclusionReason(service, prefs) ?? (upstreamUrl(service) ? null : 'Web入口が未登録');
    // Worker / native / infra entries do not have useful browser destinations.
    if (excludedReason === 'Web入口が未登録' || excludedReason === 'Web画面ではありません') continue;
    const path = service.viewer?.entry_path ?? '/';
    entries.push({ code: service.code, name: service.name,
      href: `/viewer/apps/${service.code}${path}`, excludedReason });
  }
  return entries;
}

export function viewerTarget(catalog: Catalog, prefs: Map<string, boolean>, code: string): ViewerTarget | null {
  const service = catalog.services.find((candidate) => candidate.code === code);
  if (!service || exclusionReason(service, prefs)) return null;
  const upstream = upstreamUrl(service);
  if (!upstream) return null;
  const origins: Record<string, string> = {};
  // Explicit same-project peers support a split web/API deployment without
  // ever accepting a URL or port supplied by the browser as a proxy target.
  for (const peer of catalog.services) {
    if (peer.code !== service.code && (!service.project_code || peer.project_code !== service.project_code)) continue;
    if (exclusionReason(peer, prefs) || !upstreamUrl(peer)) continue;
    for (const { port } of managedPortsForService(peer)) {
      if (port !== (peer.frontend_port ?? peer.port)) continue;
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        origins[`http://${host}:${port}`] = `/viewer/apps/${peer.code}`;
        origins[`ws://${host}:${port}`] = `/viewer/apps/${peer.code}`;
      }
    }
  }
  return { code, prefix: `/viewer/apps/${code}`, upstream, origins };
}
