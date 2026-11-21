import { child, parseAwsXml, value, type XmlElement } from './aws-xml.js';
import { signAwsPost, type AwsCredentials } from './sigv4.js';

export type AwsTransport = (url: string, init: RequestInit) => Promise<Response>;
type Service = 'ec2' | 'ecs' | 'sts';
type Query = Record<string, string | number | boolean>;
const VERSIONS = { ec2: '2016-11-15', sts: '2011-06-15' };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class AwsResponseError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) {
    super('aws_response_error');
  }
}

export class AwsLaunchRejected extends Error {
  constructor() { super('aws_launch_rejected'); }
}

export function isDefiniteLaunchRejection(error: unknown): boolean {
  if (error instanceof AwsLaunchRejected) return true;
  if (!(error instanceof AwsResponseError) || error.status < 400 || error.status >= 500) return false;
  return [
    'AccessDenied', 'AccessDeniedException', 'AuthFailure', 'UnauthorizedOperation', 'UnrecognizedClientException',
    'ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId', 'InvalidParameter', 'InvalidParameterValue',
    'InvalidParameterException', 'InvalidAMIID.NotFound', 'InsufficientInstanceCapacity', 'ClusterNotFoundException',
    'Unsupported', 'UnsupportedOperationException', 'ValidationException', 'SignatureDoesNotMatch',
  ].includes(error.code ?? '');
}

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value: bytes } = await reader.read();
      if (done) break;
      size += bytes.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('aws_response_too_large');
      parts.push(decoder.decode(bytes, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => { /* The stream may already have errored. */ });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class AwsProtocol {
  constructor(
    private readonly region: string,
    private readonly credentials: AwsCredentials,
    private readonly transport: AwsTransport = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async query(service: 'ec2' | 'sts', action: string, parameters: Query): Promise<XmlElement> {
    const body = new URLSearchParams({ Action: action, Version: VERSIONS[service] });
    for (const [key, value] of Object.entries(parameters)) body.set(key, String(value));
    const response = await this.send(service, body.toString(), { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' });
    const xml = parseAwsXml(response.body);
    if (!response.ok) {
      const detail = child(child(xml, 'Errors'), 'Error') ?? child(xml, 'Error');
      throw new AwsResponseError(response.status, value(detail, 'Code'));
    }
    if (xml.name !== `${action}Response`) throw new Error('unexpected_aws_xml_response');
    return xml;
  }

  async ecs(action: string, payload: object): Promise<unknown> {
    const response = await this.send('ecs', JSON.stringify(payload), {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AmazonEC2ContainerServiceV20141113.${action}`,
    });
    const data: unknown = JSON.parse(response.body);
    if (!response.ok) {
      const tag = (data as { __type?: unknown } | null)?.__type;
      throw new AwsResponseError(response.status, typeof tag === 'string' ? tag.split('#').at(-1) : undefined);
    }
    return data;
  }

  private async send(service: Service, body: string, headers: Record<string, string>) {
    const host = `${service}.${this.region}.amazonaws.com`;
    const outgoing = signAwsPost({ host, service, region: this.region, body, headers, credentials: this.credentials, now: this.now() });
    const response = await this.transport(`https://${host}/`, {
      method: 'POST', headers: outgoing, body, redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    return { ok: response.ok, status: response.status, body: await readBoundedBody(response) };
  }
}
