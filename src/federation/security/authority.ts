import { z } from 'zod';
import { requiredCredential, type MeshSecurityConfig } from './config.js';

const MAX_RESPONSE_BYTES = 128 * 1024;

/** No redirect, no cached active state, no project-token or legacy fallback. */
async function callAuthority(config: MeshSecurityConfig, endpoint: string, payload: Record<string, string>): Promise<unknown> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('authority_https_required');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      ...payload,
      client_id: requiredCredential(config.local.clientIdEnv),
      client_secret: requiredCredential(config.local.clientSecretEnv),
    }),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('authority_unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('authority_response_too_large');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function introspectWorkload(config: MeshSecurityConfig, token: string): Promise<unknown> {
  const result = z.object({ active: z.literal(true), claims: z.unknown() }).strict().parse(
    await callAuthority(config, config.authority.introspectionUrl, { token, audience: config.local.subject }),
  );
  return result.claims;
}

export async function issueWorkloadToken(config: MeshSecurityConfig, audience: string, action: string, resource: string): Promise<string> {
  const result = z.object({ access_token: z.string().min(1).max(32_768) }).strict().parse(
    await callAuthority(config, config.authority.tokenUrl, { audience, action, resource }),
  );
  return result.access_token;
}
