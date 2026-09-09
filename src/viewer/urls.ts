import type { ViewerTarget } from './catalog.js';

/** Map an upstream reference, preserving query strings and fragments. */
export function viewerUrl(value: string, target: ViewerTarget): string {
  if (value.startsWith('/viewer/') || value.startsWith('#')) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return target.prefix + value;
  // Relative assets must keep resolving against the actual document/module path.
  if (!/^(?:https?:|wss?:)?\/\//i.test(value)) return value;
  try {
    const url = new URL(value, target.upstream);
    const prefix = target.origins[url.origin];
    return prefix ? prefix + url.pathname + url.search + url.hash : value;
  } catch { return value; }
}

/** Resolve by concatenating a validated path, never URL resolution of //host. */
export function upstreamRequestUrl(requestUrl: string, target: ViewerTarget): URL {
  const request = new URL(requestUrl);
  if (!request.pathname.startsWith(target.prefix + '/')) throw new Error('invalid_viewer_path');
  const path = request.pathname.slice(target.prefix.length);
  if (/%(?:2f|5c|00)/i.test(path) || path.includes('\\')) throw new Error('invalid_viewer_path');
  const result = new URL(target.upstream);
  const basePath = target.upstream.pathname.replace(/\/$/, '');
  // Absolute upstream references already contain the declared base path. Avoid
  // turning /base/asset.js into /base/base/asset.js when they return via Viewer.
  result.pathname = basePath && (path === basePath || path.startsWith(basePath + '/'))
    ? path : basePath + path;
  result.search = request.search;
  return result;
}
