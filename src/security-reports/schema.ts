import { z } from 'zod';

/** @implements SPEC-EX-SECURITY-REPORTS */
export const serviceCode = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const section = z.object({
  status: z.enum(['reviewed', 'findings', 'unverified']),
  summary: z.string().min(1).max(2000),
  details: z.string().max(200_000),
}).strict();
export const reportInput = z.object({
  observedAt: z.string().datetime(),
  author: z.string().min(1).max(100),
  scope: z.string().min(1).max(4000),
  dependencies: section,
  communications: section,
  vulnerabilities: section,
  coverage: section,
}).strict();
export const storedReport = reportInput.extend({
  id: z.string().uuid(), service: serviceCode, recordedAt: z.string().datetime(),
});
export type ReportInput = z.infer<typeof reportInput>;
export type SecurityReport = z.infer<typeof storedReport>;
