import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { CredentialsSchema, ProfileSchema, TargetSchema, TerminalError } from './schema.js';
import { TerminalProfileStore } from './profile-store.js';
import { credentialNames, saveCredentials } from './credentials.js';
import { executeTerminalCommand, inspectHostKey } from './transport.js';
import { resolveTerminalAddress } from './network-policy.js';
import { isLocalTerminalRequest } from './request-policy.js';

/** @implements SPEC-TERMINAL-CONNECTIONS */
const logger = createNamedLogger('excubitor.terminal');
const CommandSchema = z.object({ command: z.string().min(1).max(16384).refine((s) => !s.includes('\0')),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000) }).strict();

export function buildTerminalRouter(store = new TerminalProfileStore()): Hono {
  const app = new Hono();
  let running = 0;
  // This is a local operator surface, never mounted on the federation or DMZ listeners.
  // The custom header prevents cross-site form requests; Origin and Host prevent browser rebinding.
  app.use('/api/v1/terminal/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!isLocalTerminalRequest(c.req.url, c.req.header('origin'))
      || c.req.header('x-excubitor-terminal') !== '1') return c.json({ error: 'local_terminal_only' }, 403);
    await next();
  });
  app.onError((error, c) => {
    const code = error instanceof TerminalError ? error.code : 'terminal_operation_failed';
    // Never log raw SSH errors, submitted commands, output or credentials.
    logger.warn({ code }, 'terminal request failed');
    return c.json({ error: code }, 400);
  });
  app.use('/api/v1/terminal/*', bodyLimit({ maxSize: 300_000 }));
  app.get('/api/v1/terminal/profiles', (c) => c.json({ profiles: store.list().map((p) => ({ ...p, credentialNames: credentialNames(p.id) })) }));
  app.put('/api/v1/terminal/profiles/:id', async (c) => {
    const parsed = z.object({ profile: ProfileSchema, credentials: CredentialsSchema.optional() }).strict().safeParse(await c.req.json());
    if (!parsed.success || parsed.data.profile.id !== c.req.param('id')) return c.json({ error: 'invalid_profile' }, 400);
    await resolveTerminalAddress(parsed.data.profile);
    if (parsed.data.credentials) await saveCredentials(parsed.data.profile.id, parsed.data.credentials);
    store.put(parsed.data.profile);
    return c.json({ ok: true });
  });
  app.delete('/api/v1/terminal/profiles/:id', (c) => {
    store.remove(c.req.param('id'));
    // Retain Vault entries: deletion of a profile must not silently destroy reusable credentials.
    return c.json({ ok: true, credentialsRetained: true });
  });
  app.post('/api/v1/terminal/inspect', async (c) => {
    const parsed = TargetSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_target' }, 400);
    if (running >= 4) return c.json({ error: 'terminal_busy' }, 429);
    running++;
    try { return c.json(await inspectHostKey(parsed.data)); } finally { running--; }
  });
  app.post('/api/v1/terminal/profiles/:id/exec', async (c) => {
    const profile = store.get(c.req.param('id'));
    if (!profile) return c.json({ error: 'profile_not_found' }, 404);
    const parsed = CommandSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_command' }, 400);
    if (running >= 4) return c.json({ error: 'terminal_busy' }, 429);
    const operationId = randomUUID();
    running++;
    logger.info({ operationId, profileId: profile.id }, 'terminal command started');
    try {
      const result = await executeTerminalCommand(profile, parsed.data.command, parsed.data.timeoutMs, c.req.raw.signal);
      logger.info({ operationId, profileId: profile.id, exitCode: result.exitCode }, 'terminal command finished');
      return c.json({ operationId, ...result });
    } finally { running--; }
  });
  return app;
}
