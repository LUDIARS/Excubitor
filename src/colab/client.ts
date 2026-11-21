import { z } from 'zod';
import { meshRequestHeaders } from '../federation/security/client-auth.js';
import type { RemotePeer } from '../federation/store.js';
import { verifyArtifactBytes } from './artifact-integrity.js';
import { readBoundedResponse } from './bounded-response.js';
import {
  artifactManifest, artifactSchema, COLAB_RESOURCE, colabActions, MAX_ARTIFACT_BYTES,
  MAX_RESULT_BYTES, MESH_JOBS, RESULT_NAME, type ColabSubmit,
} from './protocol.js';
import { receiptSchema } from './receipt.js';

const JSON_LIMIT = 32 * 1024;
const peerErrorSchema = z.object({ error: z.string().regex(/^colab_[a-z_]+$/).max(64) }).strict();

export class ColabSiteClient {
  constructor(private readonly deps: { fetch: typeof fetch; headers: typeof meshRequestHeaders }) {}

  submit(peer: RemotePeer, payload: ColabSubmit): Promise<Response> { return this.call(peer, 'submit', '', payload); }
  status(peer: RemotePeer, id: string): Promise<Response> { return this.call(peer, 'status', `/${id}`); }
  cancel(peer: RemotePeer, id: string): Promise<Response> { return this.call(peer, 'cancel', `/${id}/cancel`, {}); }
  collect(peer: RemotePeer, id: string, name?: string): Promise<Response> {
    return this.call(peer, 'collect', `/${id}/collect`, name ? { name } : {}, name);
  }

  private async call(peer: RemotePeer, operation: keyof typeof colabActions, suffix: string,
    payload?: unknown, name?: string): Promise<Response> {
    const method = operation === 'status' ? 'GET' : 'POST';
    const path = MESH_JOBS + suffix;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    try {
      const origin = new URL(peer.base_url);
      if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search ||
          origin.hash || origin.username || origin.password) throw new Error('invalid_colab_peer_origin');
      const headers = await this.deps.headers(peer, method, path, body, colabActions[operation], COLAB_RESOURCE);
      const response = await this.deps.fetch(new URL(path, origin), {
        method, headers, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (response.ok && name) return await this.artifact(response, name);
      const bytes = await readBoundedResponse(response, JSON_LIMIT);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!response.ok) {
        const safe = peerErrorSchema.safeParse(value);
        return Response.json(safe.success ? safe.data : { error: 'colab_site_rejected' }, { status: response.status });
      }
      const schema = operation === 'collect' ? artifactManifest : receiptSchema;
      return Response.json(schema.parse(value), { status: response.status, headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ error: 'colab_site_response_unverified' }, { status: 502 });
    }
  }

  private async artifact(response: Response, name: string): Promise<Response> {
    const bytesHeader = response.headers.get('content-length');
    const limit = name === RESULT_NAME ? MAX_RESULT_BYTES : MAX_ARTIFACT_BYTES;
    const expected = artifactSchema.safeParse({
      name, bytes: bytesHeader !== null && /^\d+$/.test(bytesHeader) ? Number(bytesHeader) : NaN,
      sha256: response.headers.get('x-artifact-sha256'),
    });
    if (!expected.success || response.headers.get('content-type') !== 'application/octet-stream') {
      await response.body?.cancel();
      throw new Error('colab_peer_invalid_artifact_headers');
    }
    const bytes = await readBoundedResponse(response, limit, expected.data.bytes);
    if (!verifyArtifactBytes({ bytes, expected: expected.data, limit })) throw new Error('colab_peer_artifact_digest_mismatch');
    return new Response(new Uint8Array(bytes), { headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename="${name}"`,
      'x-artifact-sha256': expected.data.sha256,
      'cache-control': 'no-store',
    } });
  }
}

export const colabSiteClient = new ColabSiteClient({ fetch, headers: meshRequestHeaders });
