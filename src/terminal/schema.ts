import { isIP } from 'node:net';
import { z } from 'zod';

/** @implements SPEC-TERMINAL-CONNECTIONS */
export const HostSchema = z.string().trim().min(1).max(253).refine((host) =>
  isIP(host) !== 0 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host), 'Invalid hostname or IP address');
export const TargetSchema = z.object({
  host: HostSchema,
  port: z.number().int().min(1).max(65535).default(22),
  network: z.enum(['private', 'external']),
  auth: z.enum(['password', 'key']),
}).strict().refine((p) => p.network !== 'external' || p.auth === 'key', 'External connections require SSH keys');
export const ProfileSchema = z.object({
  id: z.string().uuid(),
  serverName: z.string().trim().min(1).max(100),
  host: HostSchema,
  port: z.number().int().min(1).max(65535),
  network: z.enum(['private', 'external']),
  auth: z.enum(['password', 'key']),
  hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
}).strict().refine((p) => p.network !== 'external' || p.auth === 'key', 'External connections require SSH keys');
export type TerminalProfile = z.infer<typeof ProfileSchema>;
export type TerminalTarget = z.infer<typeof TargetSchema>;
export const CredentialsSchema = z.object({
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(65536).optional(),
  privateKey: z.string().min(1).max(65536).optional(),
  passphrase: z.string().max(65536).optional(),
}).strict();
export type CredentialsInput = z.infer<typeof CredentialsSchema>;
export class TerminalError extends Error {
  constructor(readonly code: string) { super(code); }
}
