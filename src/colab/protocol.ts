import { z } from 'zod';

export const RESULT_NAME = 'cc-result.json';
export const MAX_RESULT_BYTES = 128 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUTS = 8;
export const MAX_REQUEST_BYTES = 4096;
export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
export const revision = z.string().regex(/^[0-9a-f]{40}$/);
export const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const jobId = z.string().uuid();
export const gpu = z.enum(['T4', 'L4', 'G4', 'H100', 'A100']);
export const fileName = z.string().max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(name => !name.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));

export const submitSchema = z.object({
  idempotencyKey: identifier,
  ownerId: identifier,
  ownerStart: z.literal(true),
  programId: identifier,
  sourceRevision: revision,
  programSha256: sha256,
  gpu,
  deadlineAt: z.number().int().positive().safe(),
  code: z.literal('public'),
  data: z.literal('non_confidential'),
}).strict();
export type ColabSubmit = z.infer<typeof submitSchema>;

export const collectSchema = z.object({ name: fileName.optional() }).strict();
export const artifactSchema = z.object({
  name: fileName,
  bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
  sha256,
}).strict();
export type ColabArtifact = z.infer<typeof artifactSchema>;
export const artifactManifest = z.object({ files: z.array(artifactSchema).min(1).max(MAX_OUTPUTS + 1) }).strict();

export const colabActions = {
  submit: 'operation:start',
  status: 'operation:reflect',
  cancel: 'operation:stop',
  collect: 'operation:data-export',
} as const;
export type ColabAction = typeof colabActions[keyof typeof colabActions];
export const COLAB_SERVICE = 'colab-site-runner';
export const COLAB_RESOURCE = `service:${COLAB_SERVICE}`;
export const MESH_JOBS = '/api/v1/federation/colab/jobs';
