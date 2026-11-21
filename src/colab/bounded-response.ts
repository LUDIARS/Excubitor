export async function readBoundedResponse(response: Response, limit: number, expectedBytes?: number): Promise<Buffer> {
  const body = response.body;
  if (body === null) throw new Error('colab_peer_body_missing');
  const sizeText = response.headers.get('content-length');
  if ((sizeText !== null && (!/^\d+$/.test(sizeText) || Number(sizeText) > limit)) ||
      (expectedBytes !== undefined && sizeText !== String(expectedBytes))) {
    await body.cancel();
    throw new Error('colab_peer_body_size_invalid');
  }
  const reader = body.getReader();
  const fixed = expectedBytes === undefined ? null : Buffer.allocUnsafe(expectedBytes);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return fixed ? fixed.subarray(0, size) : Buffer.concat(chunks, size);
      const nextSize = size + value.byteLength;
      if (nextSize > limit || (expectedBytes !== undefined && nextSize > expectedBytes)) throw new Error('colab_peer_body_too_large');
      if (fixed) fixed.set(value, size);
      else chunks.push(value);
      size = nextSize;
    }
  } finally {
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}
