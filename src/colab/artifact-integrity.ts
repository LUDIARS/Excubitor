import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:18388a27 */
import augurContract_6d8f7499 from './contracts/c-43.contract.js'; /* augur-inject:contract-predicate:c8920382 */

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyArtifactBytes(input: {
  bytes: Uint8Array;
  expected: { bytes: number; sha256: string };
  limit: number;
}): boolean {
  return input.bytes.byteLength <= input.limit && input.bytes.byteLength === input.expected.bytes &&
    sha256Bytes(input.bytes) === input.expected.sha256;
}
// @ts-expect-error augur-inject
verifyArtifactBytes = contract(verifyArtifactBytes, { ...augurContract_6d8f7499, contractId: 'C-43', mode: 'observe', sample: 1, where: 'src/colab/artifact-integrity.ts:8', rule: 'contract-wrap', id: '6d8f7499' }); /* augur-inject:contract-wrap:6d8f7499 */

/** Keep the allocation bounded even if a file changes size after stat. */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('colab_file_too_large');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('colab_file_size_changed');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
