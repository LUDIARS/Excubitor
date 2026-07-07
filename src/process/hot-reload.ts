import { readFile } from 'node:fs/promises';
import type { Service } from '../catalog/loader.js';

export type HotReloadSource =
  | { kind: 'command'; command: string }
  | { kind: 'dev-process-md'; command: string }
  | { kind: 'start_script'; path: string };

export interface HotReloadDetection {
  source: HotReloadSource['kind'];
  marker: string;
}

export interface HotReloadGuardOptions {
  allowHotReload?: boolean;
}

const HOT_RELOAD_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev(?:[:_-][a-z0-9_-]+)?|start:dev)\b/i, 'npm/pnpm/yarn/bun dev'],
  [/\b(?:vite|next|nuxt|astro|svelte-kit)\s+(?:dev\b|--host\b|--port\b|$)/i, 'frontend dev server'],
  [/\bwebpack\s+serve\b/i, 'webpack serve'],
  [/\bwebpack-dev-server\b/i, 'webpack-dev-server'],
  [/\btsx\s+watch\b/i, 'tsx watch'],
  [/\bnode\s+--watch(?:=|\b)/i, 'node --watch'],
  [/\bnodemon\b/i, 'nodemon'],
  [/\bdotnet\s+watch\b/i, 'dotnet watch'],
  [/\bcargo\s+watch\b/i, 'cargo watch'],
  [/\btauri\s+dev\b/i, 'tauri dev'],
  [/\bwatchexec\b/i, 'watchexec'],
  [/\bair\b/i, 'air'],
];

export async function assertHotReloadAllowed(
  svc: Service,
  source: HotReloadSource,
  opts: HotReloadGuardOptions = {},
): Promise<void> {
  if (opts.allowHotReload === true || svc.allow_hot_reload === true) return;
  const detection = await detectHotReload(source);
  if (!detection) return;
  throw new Error(
    `hot reload is disabled for service ${svc.code}; ${detection.source} matches ${detection.marker}. ` +
      `Set allow_hot_reload: true in catalog/services.yaml or use a non-watch start command.`,
  );
}

export async function detectHotReload(source: HotReloadSource): Promise<HotReloadDetection | null> {
  if (source.kind === 'start_script') {
    let text: string;
    try {
      text = await readFile(source.path, 'utf8');
    } catch (err) {
      return {
        source: source.kind,
        marker: `uninspectable start_script (${(err as Error).message})`,
      };
    }
    const marker = detectHotReloadCommand(text);
    return marker ? { source: source.kind, marker } : null;
  }
  const marker = detectHotReloadCommand(source.command);
  return marker ? { source: source.kind, marker } : null;
}

export function detectHotReloadCommand(input: string): string | null {
  const normalized = stripComments(input).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  for (const [pattern, marker] of HOT_RELOAD_PATTERNS) {
    if (pattern.test(normalized)) return marker;
  }
  return null;
}

function stripComments(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('::') && !line.toLowerCase().startsWith('rem '))
    .join('\n');
}
