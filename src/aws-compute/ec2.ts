import { AwsProtocol, AwsResponseError } from './aws-protocol.js';
import { child, items, value, type XmlElement } from './aws-xml.js';
import { ec2UserData } from './ec2-user-data.js';
import type { LaunchIntent, ResourceObservation } from './job-types.js';
import { resourceTime, type ComputeProvider } from './provider.js';
import { OWNER_TAG } from './resource-tags.js';
import type { Ec2Target } from './target-schema.js';

const instanceId = /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/;
type Filters = Array<[name: string, values: string[]]>;

function ec2Observation(instance: XmlElement): ResourceObservation {
  const id = value(instance, 'instanceId');
  const state = value(child(instance, 'instanceState'), 'name');
  if (!id || !instanceId.test(id) || !state || !['pending', 'running', 'shutting-down', 'terminated', 'stopping', 'stopped'].includes(state)) {
    throw new Error('invalid_ec2_observation');
  }
  const tags = Object.fromEntries(items(instance, 'tagSet').flatMap((tag) => {
    const key = value(tag, 'key');
    const contents = value(tag, 'value');
    return key && contents !== undefined ? [[key, contents]] : [];
  }));
  const launched = resourceTime(value(instance, 'launchTime'));
  return {
    id, state, tags,
    terminal: state === 'terminated',
    stopping: state === 'shutting-down',
    createdAt: launched,
    startedAt: null, // launchTime is the launch request time, not the runner's start time.
    stoppedAt: null, // DescribeInstances has no authoritative termination timestamp.
    containers: [],
  };
}

function numberedFilters(filters: Filters): Record<string, string> {
  const pairs = filters.flatMap(([name, values], i) => {
    const prefix = `Filter.${i + 1}`;
    return [[`${prefix}.Name`, name], ...values.map((filter, j) => [`${prefix}.Value.${j + 1}`, filter])];
  });
  return Object.fromEntries(pairs);
}

export class Ec2Provider implements ComputeProvider {
  constructor(private readonly aws: AwsProtocol, private readonly target: Ec2Target) {}

  async prepare(intent: LaunchIntent): Promise<() => Promise<string>> {
    const runner = this.target.runners.find((candidate) => candidate.id === intent.runner);
    if (!runner) throw new Error('ec2_runner_missing');
    const userData = ec2UserData(runner, intent);
    const tagFields = Object.fromEntries(Object.entries(intent.tags).flatMap(([key, contents], i) => {
      const prefix = `TagSpecification.1.Tag.${i + 1}`;
      return [[`${prefix}.Key`, key], [`${prefix}.Value`, contents]];
    }));
    const { image, instanceType, subnet, securityGroup, instanceProfile } = this.target;
    return async () => {
      const result = await this.aws.query('ec2', 'RunInstances', {
        MinCount: 1, MaxCount: 1, ClientToken: intent.token,
        ...(image.kind === 'ami' ? { ImageId: image.id } : {
          'LaunchTemplate.LaunchTemplateId': image.id, 'LaunchTemplate.Version': image.version,
        }),
        InstanceType: instanceType, SubnetId: subnet, 'SecurityGroupId.1': securityGroup,
        ...(instanceProfile ? { 'IamInstanceProfile.Arn': instanceProfile } : {}),
        InstanceInitiatedShutdownBehavior: 'terminate', DisableApiTermination: false, DisableApiStop: false,
        'MetadataOptions.HttpTokens': 'required', UserData: userData,
        'TagSpecification.1.ResourceType': 'instance', ...tagFields,
      });
      const instances = items(result, 'instancesSet');
      const id = value(instances[0], 'instanceId');
      if (instances.length !== 1 || !id || !instanceId.test(id)) throw new Error('ec2_launch_unconfirmed');
      return id;
    };
  }

  async reconcile(token: string, tags: Record<string, string>): Promise<ResourceObservation | null> {
    const filters: Filters = [['client-token', [token]], ...Object.entries(tags).map(([key, contents]): [string, string[]] => [`tag:${key}`, [contents]])];
    const page = await this.list(filters);
    if (page.cursor || page.resources.length > 1) throw new Error('ec2_multiple_matches');
    return page.resources[0] ?? null;
  }

  async describe(resource: string): Promise<ResourceObservation | null> {
    try {
      const result = await this.aws.query('ec2', 'DescribeInstances', { 'InstanceId.1': resource });
      return this.observations(result).find((item) => item.id === resource) ?? null;
    } catch (error) {
      if (error instanceof AwsResponseError && error.code === 'InvalidInstanceID.NotFound') return null;
      throw error;
    }
  }

  async stop(resource: string): Promise<void> {
    await this.aws.query('ec2', 'TerminateInstances', { 'InstanceId.1': resource });
  }

  async inventory(owner: string, cursor?: string) {
    return this.list([
      [`tag:${OWNER_TAG}`, [owner]],
      ['instance-state-name', ['pending', 'running', 'stopping', 'stopped', 'shutting-down']],
    ], cursor);
  }

  private async list(filters: Filters, cursor?: string) {
    const result = await this.aws.query('ec2', 'DescribeInstances', {
      ...numberedFilters(filters), MaxResults: 100, ...(cursor ? { NextToken: cursor } : {}),
    });
    return { resources: this.observations(result), cursor: value(result, 'nextToken') || undefined };
  }

  private observations(result: XmlElement): ResourceObservation[] {
    return items(result, 'reservationSet').flatMap((reservation) => items(reservation, 'instancesSet').map(ec2Observation));
  }
}
