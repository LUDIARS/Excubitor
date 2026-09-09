import type { Context } from 'hono';
import type { ViewerTarget } from './catalog.js';
import { upstreamHeaders, viewerHeaders } from './headers.js';
import { upstreamRequestUrl } from './urls.js';
import { rewriteCss, rewriteHtml, rewriteModules } from './rewrite.js';

const MAX_REWRITE_BYTES = 16 * 1024 * 1024;

function streamResponse(body: ReadableStream<Uint8Array>, abort: () => void, cleanup: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          finish();
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(part.value);
      } catch (error) {
        abort();
        try { reader.releaseLock(); }
        finally { finish(); controller.error(error); }
      }
    },
    async cancel(reason) {
      abort();
      try { await reader.cancel(reason); }
      finally { finish(); reader.releaseLock(); }
    },
  });
}

export async function proxyViewer(c: Context, target: ViewerTarget): Promise<Response> {
  if (c.req.header('service-worker') === 'script') return c.text('Service workers are disabled inside Viewer', 403);
  if (['CONNECT', 'TRACE'].includes(c.req.method)) return c.text('Method not allowed', 405);
  let url: URL;
  try { url = upstreamRequestUrl(c.req.url, target); }
  catch { return c.text('Invalid Viewer path', 400); }
  const request = c.req.raw;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30_000);
  const cleanup = (): void => {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
  };
  let streamOwnsCleanup = false;
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method, headers: upstreamHeaders(request.headers, target),
      redirect: 'manual', signal: controller.signal,
    };
    if (!['GET', 'HEAD'].includes(request.method)) { init.body = request.body; init.duplex = 'half'; }
    const response = await fetch(url, init);
    const headers = viewerHeaders(response.headers, target);
    // fetch may decode compressed content even if upstream ignores identity.
    headers.delete('content-encoding');
    headers.delete('content-length');
    const contentType = headers.get('content-type') ?? '';
    const transform = /text\/html/i.test(contentType) ? rewriteHtml
      : /(?:java|ecma)script/i.test(contentType) ? rewriteModules
      : /text\/css/i.test(contentType) ? rewriteCss : null;
    if (transform && response.body && request.method !== 'HEAD') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_REWRITE_BYTES) {
            await reader.cancel();
            return c.text('Viewer document exceeds rewrite limit', 502);
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      headers.delete('etag');
      headers.delete('content-md5');
      const body = transform(Buffer.concat(chunks).toString('utf8'), target, headers);
      return new Response(body, { status: response.status, headers });
    }
    if (response.body && request.method !== 'HEAD') {
      clearTimeout(timeout); // SSE is intentionally not given a total-duration timeout.
      streamOwnsCleanup = true;
      return new Response(streamResponse(response.body, abort, cleanup), { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return c.text('このサービスへ接続できません。ExのMonitorで稼働状態を確認してください。', 502);
  } finally {
    if (!streamOwnsCleanup) cleanup();
  }
}
