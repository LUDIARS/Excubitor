import type { ViewerTarget } from './catalog.js';

/** C-25: a same-origin request whose referrer is another app (or missing) is never attributed to the target. */
export default {
  post: (result: boolean, headers: Headers, target: ViewerTarget) => {
    if (headers.get('sec-fetch-site') !== 'same-origin' || headers.get('sec-fetch-mode') === 'websocket') return result === false || 'non same-origin request treated as cross-app';
    const referer = headers.get('referer');
    if (!referer) return result === true || 'same-origin request without referrer forwarded with cookies';
    let path: string;
    try { path = new URL(referer).pathname; } catch { return result === true || 'unparseable referrer forwarded with cookies'; }
    const own = [target.prefix, ...Object.values(target.origins)].some((prefix) => path === prefix || path.startsWith(prefix + '/'));
    return !own || result === false || "the app's own request was treated as cross-app";
  },
};
