import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { EMPTY_BROWSER_ALLOWLIST, evaluateBrowserRequest } from '../security/browser-allowlist.js';

/** Public MCP and reverse proxies must not turn remote requests into loopback AWS operations. */
export function isAwsComputeLoopback(context: Context): boolean {
  const request = context.req;
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip', 'cf-access-jwt-assertion']
    .some((header) => request.header(header) !== undefined)) return false;
  const address = getConnInfo(context).remote.address?.replace(/^::ffff:/, '');
  if (address !== '127.0.0.1' && address !== '::1') return false;
  const url = new URL(request.url);
  return evaluateBrowserRequest({
    host: request.header('host') ?? url.host,
    protocol: url.protocol,
    origin: request.header('origin'),
    secFetchSite: request.header('sec-fetch-site'),
    allowlist: EMPTY_BROWSER_ALLOWLIST,
  }).ok;
}
