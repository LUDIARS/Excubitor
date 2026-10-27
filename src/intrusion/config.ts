import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isPrivateHttpOrigin } from './origin.js';

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
    origin: z.string().url().refine(isPrivateHttpOrigin, 'origin must be an explicit private IPv4 HTTP port'),
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
  if (new Set(config.tunnels.map(t => t.id)).size !== config.tunnels.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate tunnel ID' });
  }
  const covered = new Set(config.tunnels.flatMap(t => t.hostnames));
  if (hosts.some(h => !covered.has(h)) || [...covered].some(h => !hosts.includes(h))) {
    ctx.addIssue({ code: 'custom', message: 'tunnel and gateway hostname coverage must match' });
  }
});
export type IntrusionConfig = z.infer<typeof intrusionConfigSchema>;

export function readIntrusionConfig(env: NodeJS.ProcessEnv = process.env): IntrusionConfig | null {
  const file = env.EXCUBITOR_INTRUSION_CONFIG?.trim();
  if (!file) return null;
  return intrusionConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
