import { join } from 'node:path';
import { loadCatalog, type Catalog, type Service } from '../catalog/loader.js';
import { syncCatalog } from '../catalog/sync.js';
import { runAutostart } from '../process/autostart.js';
import { controlService } from '../control/manager.js';
import { getLaunchProfile } from '../launch/profile.js';
import { startSelection } from '../launch/orchestrator.js';
import { detectSafeMode } from '../safe-mode.js';
import { setGlobalEnv } from '../process/inject.js';
import { reconcileProcesses } from '../process/reconcile.js';
import { setCatalogServices } from '../process/service-registry.js';
import { setTopologyFromCatalog } from '../process/topology.js';

export class SupervisorCatalogRuntime {
  private services = new Map<string, Service>();
  private refreshTail: Promise<Catalog> | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly catalogPath = join(rootDir, 'catalog', 'services.yaml'),
  ) {}

  async initialize(options: { shouldStop?: () => boolean } = {}): Promise<Catalog> {
    const catalog = await this.refresh();
    if (options.shouldStop?.()) return catalog;
    await reconcileProcesses(catalog);
    if (detectSafeMode() || options.shouldStop?.()) return catalog;
    await runAutostart(catalog, options.shouldStop);
    if (options.shouldStop?.()) return catalog;
    const profile = getLaunchProfile();
    if (profile.configured && profile.autoLaunch && profile.selection.length > 0) {
      await startSelection(catalog, profile.selection, {
        actor: 'supervisor-auto-launch',
        control: controlService,
        shouldStop: options.shouldStop,
      });
    }
    return catalog;
  }

  async refresh(): Promise<Catalog> {
    const loadAndSync = async (): Promise<Catalog> => {
      const catalog = loadCatalog(this.catalogPath);
      await syncCatalog(catalog);
      setTopologyFromCatalog(catalog);
      setCatalogServices(catalog.services);
      setGlobalEnv(catalog.global?.env ?? {});
      this.services = new Map(catalog.services.map((service) => [service.code, service]));
      return catalog;
    };
    const next = this.refreshTail
      ? this.refreshTail.then(loadAndSync, loadAndSync)
      : loadAndSync();
    this.refreshTail = next;
    return next;
  }

  service(code: string): Service | undefined {
    return this.services.get(code);
  }
}
