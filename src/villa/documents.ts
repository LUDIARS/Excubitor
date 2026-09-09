import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Explicit HTML routes only; never expose the repository as a file server. */
export async function readVillaDocument(root: string, requestPath: string): Promise<string | null> {
  const parsed: unknown = JSON.parse(await readFile(resolve(root, 'routes.json'), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Villa routes');
  const routes = parsed as Record<string, unknown>;
  for (const [route, file] of Object.entries(routes)) {
    if (!route.startsWith('/') || route.startsWith('//') || typeof file !== 'string' || !file.endsWith('.html')) {
      throw new Error('Invalid Villa route');
    }
  }
  let path: string;
  try { path = decodeURIComponent(requestPath); } catch { return null; }
  if (path.includes('\\') || path.includes('\0')) return null;
  const file = Object.hasOwn(routes, path) ? routes[path] as string : undefined;
  if (!file) return null;
  const actualRoot = await realpath(root);
  const target = await realpath(resolve(actualRoot, file)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!target) return null;
  const child = relative(actualRoot, target);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('Villa route escapes document root');
  return readFile(target, 'utf8');
}
