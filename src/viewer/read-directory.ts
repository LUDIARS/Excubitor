import { readFileSync, statSync } from 'node:fs';
import { parseViewerManifest, type ViewerDirectory } from './manifest.js';

/** Read the small management-owned snapshot, failing closed on absence or expiry. */
export function readViewerDirectory(file: string): ViewerDirectory {
  const read = () => {
    if (statSync(file).size > 1024 * 1024) throw new Error('Viewer directory too large');
    return parseViewerManifest(readFileSync(file, 'utf8'), Date.now());
  };
  return {
    entries: () => read().entries,
    monitor: () => read().monitor ?? null,
    target: (code) => {
      const target = read().targets.find((entry) => entry.code === code);
      return target ? { ...target, upstream: new URL(target.upstream) } : null;
    },
  };
}
