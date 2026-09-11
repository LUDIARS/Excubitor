import { z } from 'zod';

// Deliberate projection: never copy the management response wholesale. Unknown
// fields (including paths, logs, environment and commands) are stripped here.
/** @implements SPEC-VIEWER-MONITOR */
export const monitorSnapshotSchema = z.object({
  projects: z.array(z.object({
    project_code: z.string(),
    project_name: z.string(),
    components: z.array(z.object({
      code: z.string(), name: z.string(),
      disabled: z.boolean().optional(),
      component: z.string().nullable(), runtime: z.string().nullable(),
      state: z.string(), port: z.number().nullable(),
      git: z.object({ branch: z.string().nullable(), hash: z.string().nullable(), dirty: z.boolean().nullable() }),
      package_version: z.string().nullable(), monitor_only: z.boolean(),
      host: z.null(), last_seen_at: z.number().nullable(), docker_id: z.string().nullable(),
      health_ok: z.boolean().nullable(), health_checked_at: z.number().nullable(),
    })),
  })),
});

export type MonitorSnapshot = z.infer<typeof monitorSnapshotSchema>;
