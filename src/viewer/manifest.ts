import { z } from 'zod';
import type { ViewerEntry, ViewerTarget } from './catalog.js';
import { monitorSnapshotSchema, type MonitorSnapshot } from './monitor-snapshot.js';

const code = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const targetSchema = z.object({
  code,
  prefix: z.string(),
  upstream: z.string().url(),
  origins: z.record(z.string(), z.string()),
}).strict();
export const viewerManifestSchema = z.object({
  version: z.literal(1),
  expiresAt: z.number().finite(),
  entries: z.array(z.object({
    code, name: z.string(), href: z.string(), excludedReason: z.null(),
  }).strict()),
  targets: z.array(targetSchema),
  monitor: monitorSnapshotSchema.optional(),
}).strict();
export type ViewerManifest = z.infer<typeof viewerManifestSchema>;

export interface ViewerDirectory {
  entries(): ViewerEntry[];
  target(code: string): ViewerTarget | null;
  monitor?(): MonitorSnapshot | null;
}

/** Routing and an explicit display projection, never env, commands or credentials. */
export function parseViewerManifest(text: string, now: number): ViewerManifest {
  const manifest = viewerManifestSchema.parse(JSON.parse(text));
  if (manifest.expiresAt <= now) throw new Error('Viewer directory expired');
  const targetCodes = new Set<string>();
  for (const target of manifest.targets) {
    const url = new URL(target.upstream);
    if (targetCodes.has(target.code) || target.prefix !== `/viewer/apps/${target.code}`
      || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash) throw new Error('Invalid Viewer target');
    targetCodes.add(target.code);
  }
  const entryCodes = new Set<string>();
  for (const entry of manifest.entries) {
    const expectedPrefix = `/viewer/apps/${entry.code}/`;
    const href = new URL(entry.href, 'http://viewer.invalid');
    if (entryCodes.has(entry.code) || entry.href !== href.pathname + href.search + href.hash
      || !href.pathname.startsWith(expectedPrefix)) throw new Error('Invalid Viewer entry');
    if (entry.code === 'excubitor') {
      if (!manifest.monitor || entry.href !== '/viewer/apps/excubitor/' || targetCodes.has(entry.code)) {
        throw new Error('Invalid Monitor entry');
      }
    } else if (entry.code !== 'villa' && !targetCodes.has(entry.code)) throw new Error('Missing Viewer target');
    entryCodes.add(entry.code);
  }
  for (const target of manifest.targets) {
    if (!entryCodes.has(target.code)) throw new Error('Unpublished Viewer target');
    for (const [origin, prefix] of Object.entries(target.origins)) {
      const url = new URL(origin);
      const prefixMatch = /^\/viewer\/apps\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/.exec(prefix);
      if (url.origin !== origin || !['http:', 'ws:'].includes(url.protocol)
        || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port
        || url.pathname !== '/' || url.username || url.password || url.search || url.hash
        || !prefixMatch?.[1] || !targetCodes.has(prefixMatch[1])) {
        throw new Error('Invalid Viewer origin mapping');
      }
    }
  }
  return manifest;
}
