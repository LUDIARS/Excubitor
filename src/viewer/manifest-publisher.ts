import { rmSync } from 'node:fs';
import type { Catalog } from '../catalog/loader.js';
import { publishViewerManifest } from './publish-manifest.js';

/** Owns publication lifetime. Failed refreshes cannot extend the previous lease. */
export function startViewerManifestPublisher(
  file: string, getCatalog: () => Catalog, getPrefs: () => Map<string, boolean>,
  reportError: () => void,
): () => void {
  const publish = (): void => {
    try { publishViewerManifest(file, getCatalog(), getPrefs(), Date.now()); }
    catch { reportError(); } // A failed publication expires in at most 30 seconds.
  };
  publish();
  const timer = setInterval(publish, 10_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    try { rmSync(file, { force: true }); }
    catch { reportError(); } // Lease expiry also covers unavailable storage at shutdown.
  };
}
