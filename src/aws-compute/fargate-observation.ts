import { z } from 'zod';
import type { ResourceObservation } from './job-types.js';

export const ecsTaskArn = z.string().regex(/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/[A-Za-z0-9_-]+\/[a-f0-9]{32}$/);
export const ecsTaskList = z.object({ taskArns: z.array(z.string()).max(100), nextToken: z.string().nullish() });
export const ecsFailures = z.array(z.object({ reason: z.string().optional() })).default([]);

const epochSeconds = z.number().nonnegative().max(8.64e12).transform((seconds) => Math.round(seconds * 1000));
const taskSchema = z.object({
  taskArn: ecsTaskArn,
  clusterArn: z.string(),
  launchType: z.string().optional(),
  startedBy: z.string().optional(),
  lastStatus: z.enum(['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED', 'DELETED']),
  tags: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  createdAt: epochSeconds.optional(),
  startedAt: epochSeconds.optional(),
  stoppedAt: epochSeconds.optional(),
  containers: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/), exitCode: z.number().int().optional(),
  })).default([]),
});

export type EcsTask = z.infer<typeof taskSchema>;
export const ecsTaskResponse = z.object({ tasks: z.array(taskSchema).default([]), failures: ecsFailures });

export function ecsObservation(task: EcsTask): ResourceObservation {
  return {
    id: task.taskArn,
    state: task.lastStatus,
    launchToken: task.startedBy,
    terminal: task.lastStatus === 'STOPPED' || task.lastStatus === 'DELETED',
    stopping: ['DEACTIVATING', 'STOPPING', 'DEPROVISIONING'].includes(task.lastStatus),
    tags: Object.fromEntries(task.tags.map(({ key, value }) => [key, value])),
    createdAt: task.createdAt ?? null,
    startedAt: task.startedAt ?? null,
    stoppedAt: task.stoppedAt ?? null,
    containers: task.containers.map(({ name, exitCode }) => ({ name, exit_code: exitCode ?? null })),
  };
}
