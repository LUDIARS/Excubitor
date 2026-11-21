import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** The compute APIs use UTF-8 POST bodies at `/`, with no URL query parameters. */
export function signAwsPost(input: {
  host: string;
  service: string;
  region: string;
  body: string;
  headers: Record<string, string>;
  credentials: AwsCredentials;
  now: number;
}): Headers {
  const { host, service, region, body, credentials, now } = input;
  const timestamp = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const headers = new Headers(input.headers);
  headers.set('host', host);
  headers.set('x-amz-date', timestamp);
  if (credentials.sessionToken) headers.set('x-amz-security-token', credentials.sessionToken);

  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name)?.replace(/[ \t]+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const request = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256(request)].join('\n');
  const serviceKey = hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service);
  const signature = hmac(hmac(serviceKey, 'aws4_request'), toSign).toString('hex');
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return headers;
}
