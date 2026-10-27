import { readFileSync } from 'node:fs';
import { z } from 'zod';

const hostname = z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
export const intrusionConfigSchema = z.object({
  site: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/).refine(c => c !== 'XX')).min(1).default(['JP']),
  requestsPerMinute: z.number().int().min(10).max(100000).default(600),
  authFailuresPerMinute: z.number().int().min(2).max(1000).default(20),
  routes: z.array(z.object({
    hostname,
    service: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    origin: z.string().url().refine(value => {
      const url = new URL(value);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
        Boolean(url.port) && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
    }, 'origin must be an explicit loopback HTTP port'),
  }).strict()).min(1).max(200),
  tunnels: z.array(z.object({
    id: z.string().uuid(), hostnames: z.array(hostname).min(1).max(200),
  }).strict()).min(1).max(20),
}).strict().superRefine((config, ctx) => {
  const hosts = config.routes.map(r => r.hostname);
  if (new Set(hosts).size !== hosts.length) ctx.addIssue({ code: 'custom', message: 'duplicate route hostname' });
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
