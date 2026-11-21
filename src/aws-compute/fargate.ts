import { z } from 'zod';
import { AwsLaunchRejected, AwsProtocol } from './aws-protocol.js';
import { ecsObservation, ecsTaskArn, ecsTaskList, ecsTaskResponse, ecsFailures, type EcsTask } from './fargate-observation.js';
import type { LaunchIntent, ResourceObservation } from './job-types.js';
import type { ComputeProvider } from './provider.js';
import type { FargateTarget } from './target-schema.js';

const runResponse = z.object({
  tasks: z.array(z.object({ taskArn: ecsTaskArn, clusterArn: z.string() })),
  failures: ecsFailures,
});
const taskDefinitionResponse = z.object({
  taskDefinition: z.object({
    taskDefinitionArn: z.string(),
    requiresCompatibilities: z.array(z.string()),
    networkMode: z.literal('awsvpc'),
    runtimePlatform: z.object({ operatingSystemFamily: z.string().optional() }).optional(),
    containerDefinitions: z.array(z.object({ name: z.string(), stopTimeout: z.number().int().min(2).max(120) })).min(1),
  }),
});

export class FargateProvider implements ComputeProvider {
  constructor(private readonly aws: AwsProtocol, private readonly target: FargateTarget) {}

  async prepare(intent: LaunchIntent): Promise<() => Promise<string>> {
    const runner = this.target.runners.find((candidate) => candidate.id === intent.runner);
    if (!runner) throw new Error('fargate_runner_missing');
    const overrides = { containerOverrides: [{
      name: runner.container,
      ...(runner.command ? { command: runner.command } : {}),
      environment: Object.entries(intent.inputs).map(([name, value]) => ({ name, value })),
    }] };
    if (Buffer.byteLength(JSON.stringify(overrides)) > 8192) throw new Error('fargate_overrides_too_large');
    const { cluster, taskDefinition, subnets, securityGroups, assignPublicIp } = this.target;
    const { taskDefinition: definition } = taskDefinitionResponse.parse(await this.aws.ecs('DescribeTaskDefinition', { taskDefinition }));
    if (definition.taskDefinitionArn !== taskDefinition || !definition.requiresCompatibilities.includes('FARGATE')
      || (definition.runtimePlatform?.operatingSystemFamily ?? 'LINUX') !== 'LINUX'
      || !definition.containerDefinitions.some(({ name }) => name === runner.container)) {
      throw new Error('fargate_task_definition_mismatch');
    }
    return async () => {
      const result = runResponse.parse(await this.aws.ecs('RunTask', {
        cluster, taskDefinition, count: 1, launchType: 'FARGATE',
        enableExecuteCommand: false, clientToken: intent.token, startedBy: intent.token, overrides,
        tags: Object.entries(intent.tags).map(([key, value]) => ({ key, value })),
        networkConfiguration: { awsvpcConfiguration: {
          subnets, securityGroups, assignPublicIp: assignPublicIp ? 'ENABLED' : 'DISABLED',
        } },
      }));
      if (result.tasks.length === 0 && result.failures.length > 0) throw new AwsLaunchRejected();
      const task = result.tasks[0];
      if (result.tasks.length !== 1 || !task || task.clusterArn !== cluster) throw new Error('ecs_launch_unconfirmed');
      return task.taskArn;
    };
  }

  async reconcile(token: string, tags: Record<string, string>): Promise<ResourceObservation | null> {
    const page = await this.list({ startedBy: token });
    if (page.nextToken || page.taskArns.length > 1) throw new Error('ecs_multiple_matches');
    // ListTasks cannot combine startedBy with desiredStatus. The stopped history is
    // scanned separately by inventory, which can recover even an immediately exited task.
    const [task] = await this.describeTasks(page.taskArns);
    return task?.startedBy === token && Object.entries(tags).every(([key, value]) =>
      task.tags.some((tag) => tag.key === key && tag.value === value)) ? ecsObservation(task) : null;
  }

  async describe(resource: string): Promise<ResourceObservation | null> {
    const [task] = await this.describeTasks([resource]);
    return task ? ecsObservation(task) : null;
  }

  async stop(resource: string): Promise<void> {
    await this.aws.ecs('StopTask', { cluster: this.target.cluster, task: resource, reason: 'Excubitor compute release' });
  }

  async inventory(_owner: string, cursor?: string) {
    const history = cursor?.startsWith('stopped:') ?? false;
    const token = cursor?.slice(history ? 'stopped:'.length : 'running:'.length);
    const page = await this.list({
      launchType: 'FARGATE', desiredStatus: history ? 'STOPPED' : 'RUNNING',
      ...(token ? { nextToken: token } : {}),
    });
    // The cluster can still contain other clients' tasks that use the old short ARN format.
    const resources = (await this.describeTasks(page.taskArns.filter((arn) => ecsTaskArn.safeParse(arn).success))).map(ecsObservation);
    const next = page.nextToken ? `${history ? 'stopped' : 'running'}:${page.nextToken}` : (history ? undefined : 'stopped:');
    return { resources, cursor: next };
  }

  private async list(filter: Record<string, string>) {
    return ecsTaskList.parse(await this.aws.ecs('ListTasks', { cluster: this.target.cluster, maxResults: 100, ...filter }));
  }

  private async describeTasks(taskArns: string[]): Promise<EcsTask[]> {
    if (taskArns.length === 0) return [];
    const result = ecsTaskResponse.parse(await this.aws.ecs('DescribeTasks', { cluster: this.target.cluster, tasks: taskArns, include: ['TAGS'] }));
    if (result.failures.some((failure) => failure.reason !== 'MISSING')) throw new Error('ecs_describe_failed');
    return result.tasks.filter((task) =>
      task.clusterArn === this.target.cluster && taskArns.includes(task.taskArn) && task.launchType === 'FARGATE');
  }
}
