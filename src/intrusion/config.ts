import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isPrivateHttpOrigin, isCloudfrontHttpsOrigin } from './origin.js';

const hostname = z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
export const intrusionConfigSchema = z.object({
  site: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/).refine(c => c !== 'XX')).min(1).default(['JP']),
  requestsPerMinute: z.number().int().min(10).max(100000).default(600),
  authFailuresPerMinute: z.number().int().min(2).max(1000).default(20),
  routes: z.array(z.object({
    hostname,
    // Cloudflared selects the original hostname/path before replacing Host with this key.
    routeKey: z.string().regex(/^r-[a-z0-9-]{1,64}\.intrusion\.invalid$/).optional(),
    path: z.string().min(1).max(2048).optional(),
    forwardHost: z.string().regex(/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/).max(259).optional(),
    service: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    origin: z.string().url().refine(value => isPrivateHttpOrigin(value) || isCloudfrontHttpsOrigin(value), 'unsupported origin'),
    adoptExisting: z.object({ tunnelId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict()).min(1).max(200),
  tunnels: z.array(z.object({
    id: z.string().uuid(), hostnames: z.array(hostname).min(1).max(200),
  }).strict()).min(1).max(20),
}).strict().superRefine((config, ctx) => {
  const hosts = config.routes.map(r => r.hostname);
  const keys = config.routes.map(r => r.routeKey ?? r.hostname);
  const selectors = config.routes.map(r => JSON.stringify([r.hostname, r.path ?? '']));
  if (new Set(keys).size !== keys.length || new Set(selectors).size !== selectors.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate route identity' });
  }
  if (config.routes.some(r => r.path && !r.routeKey)) {
    ctx.addIssue({ code: 'custom', message: 'path-restricted routes require an internal route key' });
  }
  for (const route of config.routes) {
    if (isCloudfrontHttpsOrigin(route.origin) && !route.adoptExisting) {
      ctx.addIssue({ code: 'custom', message: 'HTTPS origin requires existing-route adoption' });
    }
    if (route.adoptExisting && (!route.routeKey || !config.tunnels.some(t =>
      t.id === route.adoptExisting?.tunnelId && t.hostnames.includes(route.hostname)))) {
      ctx.addIssue({ code: 'custom', message: 'adoption requires a route key and owning tunnel' });
    }
  }
  if (new Set(config.tunnels.map(t => t.id)).size !== config.tunnels.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate tunnel ID' });
  }
  const covered = new Set(config.tunnels.flatMap(t => t.hostnames));
  if (hosts.some(h => !covered.has(h)) || [...covered].some(h => !hosts.includes(h))) {
    ctx.addIssue({ code: 'custom', message: 'tunnel and gateway hostname coverage must match' });
  }
});
export type IntrusionConfig = z.infer<typeof intrusionConfigSchema>;

export function readIntrusionConfig(env: NodeJS.ProcessEnv = process.env, defaultFile = 'data/intrusion-config.json'): IntrusionConfig | null {
  const explicit = env.EXCUBITOR_INTRUSION_CONFIG?.trim();
  let text: string;
  try { text = readFileSync(explicit || defaultFile, 'utf8'); }
  catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return intrusionConfigSchema.parse(JSON.parse(text));
}
