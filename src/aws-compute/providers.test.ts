import { expect, it, vi } from 'vitest';
import { AwsProtocol, type AwsTransport } from './aws-protocol.js';
import { child, parseAwsXml, value } from './aws-xml.js';
import { AWS_VAULT_KEYS, AwsCredentialSource } from './credentials.js';
import { Ec2Provider } from './ec2.js';
import { FargateProvider } from './fargate.js';
import { ec2Target, fargateTarget, NOW } from './test-fixtures.js';

// Test-only key ids are assembled so the source never holds a key-shaped literal.
const accessKeyId = ['AK', 'IA', 'EXAMPLE000000000'].join('');
const sessionKeyId = ['AS', 'IA', 'EXAMPLE000000000'].join('');
const intentToken = '76d9021d-6ec7-43b4-9bac-914d71e755fa';
const secretAccessKey = 'exampleOnlySecretKey0000000000000000000';
const instanceId = 'i-0123456789abcdef0';
const taskId = 'arn:aws:ecs:us-east-1:123456789012:task/compute/0123456789abcdef0123456789abcdef';
const intent = {
  token: intentToken, runner: 'calculate',
  inputs: { REVISION: "x' ; echo example" },
  deadline: NOW + 300_000,
  tags: { 'ludiars:job-id': 'job-1', 'ludiars:owner': 'local', 'ludiars:expires-at': new Date(NOW + 300_000).toISOString() },
};

it('signs the exact POST body and includes temporary credentials in the canonical headers', async () => {
  const transport = vi.fn<AwsTransport>().mockImplementation(async (_url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get('x-amz-date')).toBe('20260101T000000Z');
    expect(headers.get('x-amz-security-token')).toBe('example-session-token');
    expect(String(init.body)).toBe('Action=DescribeInstances&Version=2016-11-15');
    expect(headers.get('authorization')).toBe(
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260101/us-east-1/ec2/aws4_request, `
      + 'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, '
      + 'Signature=07a3c07fba6501b8f0cf1ebf7acd06fd68b1ad251d01dcbe359053d410715881',
    );
    return new Response('<DescribeInstancesResponse/>');
  });
  const aws = new AwsProtocol('us-east-1', { accessKeyId, secretAccessKey, sessionToken: 'example-session-token' }, transport, () => NOW);
  await aws.query('ec2', 'DescribeInstances', {});
  expect(transport).toHaveBeenCalledOnce();
});

it('parses AWS XML namespaces and entities and rejects unsafe or malformed markup', () => {
  const xml = parseAwsXml('<?xml version="1.0" encoding="UTF-8"?><x:Root xmlns:x="urn:aws"><x:empty/><x:value>A&amp;&#x1F600;&lt;</x:value></x:Root>');
  expect(xml.name).toBe('Root');
  expect(child(xml, 'empty')).toMatchObject({ name: 'empty', value: '' });
  expect(value(xml, 'value')).toBe('A&😀<');
  for (const malformed of ['<!DOCTYPE a [<!ENTITY e SYSTEM "file:///test">]><a>&e;</a>', '<a><b></a>', '<a/><b/>', '<a>&unknown;</a>', '<a>&#xD800;</a>']) {
    expect(() => parseAwsXml(malformed)).toThrow();
  }
});

it('uses signed EC2 Query requests and builds Linux user-data exclusively from the registered runner', async () => {
  if (ec2Target.kind !== 'ec2') throw new Error('fixture kind');
  const transport = vi.fn<AwsTransport>().mockImplementation(async (url, init) => {
    expect(url).toBe('https://ec2.us-east-1.amazonaws.com/');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toMatch(/AWS4-HMAC-SHA256 .*\/us-east-1\/ec2\/aws4_request/);
    const body = new URLSearchParams(String(init.body));
    if (body.get('Action') === 'RunInstances') {
      expect(body.get('MinCount')).toBe('1');
      expect(body.get('MaxCount')).toBe('1');
      expect(body.get('ClientToken')).toBe(intent.token);
      expect(body.get('InstanceInitiatedShutdownBehavior')).toBe('terminate');
      expect(body.get('DisableApiStop')).toBe('false');
      expect(body.get('DisableApiTermination')).toBe('false');
      const script = Buffer.from(body.get('UserData') ?? '', 'base64').toString('utf8');
      expect(script.indexOf('shutdown -h "+')).toBeLessThan(script.indexOf('/opt/excubitor/job'));
      expect(script).toContain("'REVISION=x'\"'\"' ; echo example'");
      expect(script).not.toContain(secretAccessKey);
      return new Response(`<RunInstancesResponse><instancesSet><item><instanceId>${instanceId}</instanceId></item></instancesSet></RunInstancesResponse>`);
    }
    expect(body.get('Action')).toBe('DescribeInstances');
    expect(body.get('Filter.1.Name')).toBe('client-token');
    expect(body.get('Filter.1.Value.1')).toBe(intent.token);
    return new Response(`<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
      <reservationSet><item><instancesSet><item><instanceId>${instanceId}</instanceId>
      <instanceState><name>running</name></instanceState></item></instancesSet></item></reservationSet>
    </DescribeInstancesResponse>`);
  });
  const provider = new Ec2Provider(new AwsProtocol('us-east-1', { accessKeyId, secretAccessKey }, transport, () => NOW), ec2Target);
  expect(await (await provider.prepare(intent))()).toBe(instanceId);
  expect(await provider.reconcile(intent.token, intent.tags)).toMatchObject({ id: instanceId, terminal: false });
  expect(transport).toHaveBeenCalledTimes(2);
});

it('pins Fargate definition, restricts RunTask overrides and observes stopped container exit codes', async () => {
  if (fargateTarget.kind !== 'fargate') throw new Error('fixture kind');
  const transport = vi.fn<AwsTransport>().mockImplementation(async (url, init) => {
    expect(url).toBe('https://ecs.us-east-1.amazonaws.com/');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/x-amz-json-1.1');
    const body = JSON.parse(String(init.body));
    switch (headers.get('x-amz-target')?.split('.').at(-1)) {
      case 'DescribeTaskDefinition':
        expect(body.taskDefinition).toBe(fargateTarget.kind === 'fargate' && fargateTarget.taskDefinition);
        return Response.json({ taskDefinition: {
          taskDefinitionArn: fargateTarget.kind === 'fargate' && fargateTarget.taskDefinition,
          requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc',
          containerDefinitions: [{ name: 'runner', stopTimeout: 15 }],
        } });
      case 'RunTask':
        expect(body).toMatchObject({
          clientToken: intent.token, startedBy: intent.token, count: 1, enableExecuteCommand: false,
          networkConfiguration: { awsvpcConfiguration: { assignPublicIp: 'DISABLED' } },
          overrides: { containerOverrides: [{ name: 'runner', command: ['calculate'], environment: [{ name: 'REVISION', value: intent.inputs.REVISION }] }] },
        });
        expect(Object.keys(body.overrides)).toEqual(['containerOverrides']);
        return Response.json({ tasks: [{ taskArn: taskId, clusterArn: fargateTarget.kind === 'fargate' && fargateTarget.cluster }] });
      case 'DescribeTasks':
        expect(body).toMatchObject({ tasks: [taskId], include: ['TAGS'] });
        return Response.json({ tasks: [{
          taskArn: taskId, clusterArn: fargateTarget.kind === 'fargate' && fargateTarget.cluster,
          launchType: 'FARGATE', lastStatus: 'STOPPED', stoppedAt: NOW / 1_000 + 3, startedBy: intent.token,
          containers: [{ name: 'runner', exitCode: 7 }],
        }] });
      case 'StopTask':
        expect(body).toMatchObject({ task: taskId });
        return Response.json({ task: { taskArn: taskId, lastStatus: 'DEACTIVATING' } });
      default: throw new Error('unexpected AWS action');
    }
  });
  const provider = new FargateProvider(new AwsProtocol('us-east-1', { accessKeyId, secretAccessKey }, transport, () => NOW), fargateTarget);
  expect(await (await provider.prepare(intent))()).toBe(taskId);
  await provider.stop(taskId);
  expect(await provider.describe(taskId)).toMatchObject({ terminal: true, launchToken: intent.token, stoppedAt: NOW + 3_000, containers: [{ name: 'runner', exit_code: 7 }] });
});

it('resolves credentials only from Vault and signs subsequent queries with a short STS session', async () => {
  const noValues = { valuesOf: async () => ({}) };
  const absent = new AwsCredentialSource(noValues, () => { throw new Error('transport must remain unused'); });
  expect(await absent.readiness()).toEqual({ configured: false });
  await expect(absent.protocol('us-east-1')).rejects.toThrow('credentials_unavailable');

  const vault = { valuesOf: vi.fn().mockResolvedValue({
    [AWS_VAULT_KEYS.access]: accessKeyId, [AWS_VAULT_KEYS.secretKey]: secretAccessKey,
    [AWS_VAULT_KEYS.role]: 'arn:aws:iam::123456789012:role/ExCompute',
  }) };
  const transport = vi.fn<AwsTransport>().mockImplementation(async (url, init) => {
    if (url === 'https://sts.us-east-1.amazonaws.com/') {
      const body = new URLSearchParams(String(init.body));
      expect(body.get('Action')).toBe('AssumeRole');
      expect(body.get('DurationSeconds')).toBe('900');
      return new Response(`<AssumeRoleResponse><AssumeRoleResult><Credentials>
        <AccessKeyId>${sessionKeyId}</AccessKeyId><SecretAccessKey>exampleSessionSecret00000000000000000000</SecretAccessKey>
        <SessionToken>example-session-token</SessionToken><Expiration>${new Date(NOW + 900_000).toISOString()}</Expiration>
      </Credentials></AssumeRoleResult></AssumeRoleResponse>`);
    }
    const headers = new Headers(init.headers);
    expect(headers.get('x-amz-security-token')).toBe('example-session-token');
    expect(headers.get('authorization')).toContain(`Credential=${sessionKeyId}/`);
    return new Response('<DescribeInstancesResponse/>');
  });
  const credentials = new AwsCredentialSource(vault, transport, () => NOW);
  expect(await credentials.readiness()).toEqual({ configured: true });
  await (await credentials.protocol('us-east-1')).query('ec2', 'DescribeInstances', {});
  await (await credentials.protocol('us-east-1')).query('ec2', 'DescribeInstances', {});
  expect(transport).toHaveBeenCalledTimes(3);
});
