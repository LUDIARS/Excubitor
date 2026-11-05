import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const defenseConfigSchema = z.object({
  mode: z.enum(['observe', 'enforce']).default('observe'),
  dailyHourJst: z.number().int().min(0).max(23).default(9),
  blockSeconds: z.number().int().min(10).max(900).default(60),
  services: z.array(z.object({
    service: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    authPaths: z.array(z.string().regex(/^\/[^?#]*$/).max(512)).max(20).default([]),
    requestsPerMinute: z.number().int().min(10).max(100000).default(600),
    authFailuresPerMinute: z.number().int().min(2).max(1000).default(20),
    notFoundPerMinute: z.number().int().min(5).max(1000).default(60),
  }).strict()).max(200).default([]),
  watchPaths: z.array(z.string().min(1).max(1024)).max(100).default([]),
}).strict().refine(c => new Set(c.services.map(s => s.service)).size === c.services.length, 'duplicate service');
export type DefenseConfig = z.infer<typeof defenseConfigSchema>;

export function readDefenseConfig(env: NodeJS.ProcessEnv = process.env): DefenseConfig {
  const file = env.EXCUBITOR_SECURITY_DEFENSE_CONFIG || 'data/security-defense.json';
  try { return defenseConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if (!env.EXCUBITOR_SECURITY_DEFENSE_CONFIG && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defenseConfigSchema.parse({}); // Documented observation mode, exposed in status.
    }
    throw error;
  }
}
