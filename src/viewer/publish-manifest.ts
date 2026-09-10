import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { viewerEntries, viewerTarget } from './catalog.js';
import type { ViewerManifest } from './manifest.js';

/** Runs in the management process; the DMZ worker never opens the management DB. */
export function publishViewerManifest(
  file: string, catalog: Catalog, prefs: Map<string, boolean>, now: number,
): void {
  const entries = viewerEntries(catalog, prefs).filter((entry) => entry.excludedReason === null);
  const targets = entries.flatMap((entry) => {
    const target = viewerTarget(catalog, prefs, entry.code);
    return target ? [{ ...target, upstream: target.upstream.href }] : [];
  });
  const manifest: ViewerManifest = {
    version: 1, expiresAt: now + 30_000,
    entries: entries.map((entry) => ({ ...entry, excludedReason: null })), targets,
  };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
