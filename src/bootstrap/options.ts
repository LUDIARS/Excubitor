import { z } from 'zod';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export const BootstrapOptionsSchema = z.object({
  repository: z.string().regex(/^LUDIARS\/[A-Za-z0-9][A-Za-z0-9_-]*$/),
  start: z.boolean().default(true),
}).strict();
export const DataOptionsSchema = z.object({
  artifact: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
