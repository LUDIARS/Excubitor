import { z } from 'zod';

export const computeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const jobId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const region = z.string().regex(/^(?:(?:af|ap|ca|eu|il|me|mx|sa)-[a-z]+|us-(?:east|west))-[1-9][0-9]*$/);
const subnet = z.string().regex(/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/);
const group = z.string().regex(/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const argument = z.string().max(512).regex(/^[^\u0000\r\n]*$/u);
const runner = {
  id: computeId,
  inputKeys: z.array(envName).max(16).refine((keys) => new Set(keys).size === keys.length),
};
const base = {
  id: computeId,
  name: z.string().trim().min(1).max(100),
  region,
  maxRuntimeSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60),
  orphanPolicy: z.enum(['report', 'terminate']).default('report'),
};

const ec2 = z.object({
  ...base,
  kind: z.literal('ec2'),
  image: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ami'), id: z.string().regex(/^ami-(?:[a-f0-9]{8}|[a-f0-9]{17})$/) }).strict(),
    z.object({
      kind: z.literal('template'),
      id: z.string().regex(/^lt-[a-f0-9]{17}$/),
      version: z.string().regex(/^[1-9][0-9]{0,9}$/),
    }).strict(),
  ]),
  instanceType: z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/).max(40),
  subnet,
  securityGroup: group,
  instanceProfile: z.string().regex(/^arn:aws:iam::\d{12}:instance-profile\/[\w+=,.@/-]+$/).max(240).optional(),
  runners: z.array(z.object({
    ...runner,
    executable: z.string().max(240).regex(/^\/[A-Za-z0-9_./-]+$/),
    args: z.array(argument).max(12).default([]),
  }).strict()).min(1).max(12),
}).strict();

const fargate = z.object({
  ...base,
  kind: z.literal('fargate'),
  cluster: z.string().regex(/^arn:aws:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/).max(255),
  taskDefinition: z.string().regex(/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:[1-9][0-9]*$/).max(255),
  subnets: z.array(subnet).min(1).max(16).refine((items) => new Set(items).size === items.length),
  securityGroups: z.array(group).min(1).max(5).refine((items) => new Set(items).size === items.length),
  assignPublicIp: z.boolean(),
  runners: z.array(z.object({
    ...runner,
    container: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
    command: z.array(argument).min(1).max(12).optional(),
  }).strict()).min(1).max(12),
}).strict();

export const computeTargetSchema = z.discriminatedUnion('kind', [ec2, fargate]).superRefine((target, ctx) => {
  if (new Set(target.runners.map((item) => item.id)).size !== target.runners.length) {
    ctx.addIssue({ code: 'custom', path: ['runners'], message: 'runner IDs must be unique' });
  }
  if (target.kind !== 'fargate') return;
  const clusterScope = target.cluster.split(':').slice(0, 5).join(':');
  const taskScope = target.taskDefinition.split(':').slice(0, 5).join(':');
  if (!clusterScope.startsWith(`arn:aws:ecs:${target.region}:`) || clusterScope !== taskScope) {
    ctx.addIssue({ code: 'custom', path: ['taskDefinition'], message: 'cluster and task definition must share the target region and account' });
  }
});

export const submitJobSchema = z.object({
  target_id: computeId,
  job_id: jobId,
  runner: computeId,
  inputs: z.record(envName, z.string().max(512).regex(/^[^\u0000]*$/u)).default({}),
  deadline: z.string().datetime({ offset: true }),
}).strict().refine((value) => Object.keys(value.inputs).length <= 16 && Number.isFinite(Date.parse(value.deadline)));

export type ComputeTarget = z.infer<typeof computeTargetSchema>;
export type Ec2Target = Extract<ComputeTarget, { kind: 'ec2' }>;
export type FargateTarget = Extract<ComputeTarget, { kind: 'fargate' }>;
export type SubmitJob = z.infer<typeof submitJobSchema>;
