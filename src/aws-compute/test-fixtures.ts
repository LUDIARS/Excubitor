import Database from 'better-sqlite3';
import { AWS_COMPUTE_MIGRATIONS } from './schema.js';
import { ComputeRegistry } from './registry.js';
import { JobJournal } from './job-journal.js';
import { computeTargetSchema } from './target-schema.js';

export const NOW = Date.parse('2026-01-01T00:00:00.000Z');
export const ec2Target = computeTargetSchema.parse({
  id: 'linux', name: 'Linux', kind: 'ec2', region: 'us-east-1', maxRuntimeSeconds: 300,
  image: { kind: 'ami', id: 'ami-0123456789abcdef0' },
  instanceType: 't3.micro', subnet: 'subnet-0123456789abcdef0', securityGroup: 'sg-0123456789abcdef0',
  runners: [{ id: 'calculate', executable: '/opt/excubitor/job', inputKeys: ['REVISION'] }],
});
export const fargateTarget = computeTargetSchema.parse({
  id: 'containers', name: 'Container jobs', kind: 'fargate', region: 'us-east-1', maxRuntimeSeconds: 300,
  cluster: 'arn:aws:ecs:us-east-1:123456789012:cluster/compute',
  taskDefinition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/compute:3',
  subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], assignPublicIp: false,
  runners: [{ id: 'calculate', container: 'runner', command: ['calculate'], inputKeys: ['REVISION'] }],
});
export const fakeSubmit = {
  target_id: 'linux', job_id: 'job-1', runner: 'calculate',
  inputs: { REVISION: 'test-revision' }, deadline: new Date(NOW + 600_000).toISOString(),
};

export function createJournalFixture() {
  const db = new Database(':memory:');
  for (const statement of AWS_COMPUTE_MIGRATIONS) db.exec(statement);
  const registry = new ComputeRegistry(db);
  registry.put(ec2Target);
  return { db, registry, journal: new JobJournal(db, registry) };
}
