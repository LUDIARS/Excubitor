import { z } from 'zod';
import { artifactSchema, gpu, identifier, jobId, MAX_OUTPUTS, revision } from './protocol.js';

const phase = z.enum(['accepted', 'allocating', 'executing', 'collecting', 'releasing', 'release_unknown', 'released']);
const stopReason = z.enum(['cancelled', 'deadline', 'interrupted']);
const outcome = z.enum(['completed', 'failed', 'unknown', ...stopReason.options]);

export const receiptSchema = z.object({
  id: jobId, programId: identifier, sourceRevision: revision, gpu, phase,
  outcome: outcome.nullable(), stopReason: stopReason.nullable(),
  createdAt: z.number().int().safe(), deadlineAt: z.number().int().safe(),
  files: z.array(artifactSchema).max(MAX_OUTPUTS + 1),
  events: z.array(z.object({ at: z.number().int().safe(), phase }).strict()).max(10),
}).strict();
export type ColabReceipt = z.infer<typeof receiptSchema>;
