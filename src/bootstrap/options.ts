import { z } from 'zod';
import { BootstrapRepositorySchema } from './repository.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export const BootstrapOptionsSchema = z.object({
  repository: BootstrapRepositorySchema,
  start: z.boolean().default(true),
}).strict();
export const DataOptionsSchema = z.object({
  artifact: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
