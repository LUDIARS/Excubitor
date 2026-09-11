import { rmSync } from 'node:fs';
import type { Catalog } from '../catalog/loader.js';
import { publishViewerManifest } from './publish-manifest.js';
import type { MonitorSnapshot } from './monitor-snapshot.js';

/** Owns publication lifetime. Failed refreshes cannot extend the previous lease. */
export function startViewerManifestPublisher(
  file: string, getCatalog: () => Catalog, getPrefs: () => Map<string, boolean>,
  reportError: () => void,
  getMonitor?: () => Promise<MonitorSnapshot>,
): () => void {
  let stopped = false;
  let pending = false;
  const publish = async (): Promise<void> => {
    if (stopped || pending) return;
    pending = true;
    try {
      const monitor = getMonitor ? await getMonitor() : undefined;
      if (!stopped) publishViewerManifest(file, getCatalog(), getPrefs(), Date.now(), monitor);
    }
    catch { reportError(); } // A failed publication expires in at most 30 seconds.
    finally { pending = false; }
  };
  void publish();
  const timer = setInterval(() => void publish(), 10_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    try { rmSync(file, { force: true }); }
    catch { reportError(); } // Lease expiry also covers unavailable storage at shutdown.
  };
}
