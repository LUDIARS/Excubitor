import { createHash } from 'node:crypto';

export default {
  post(result: boolean, input: {
    bytes: Uint8Array; expected: { bytes: number; sha256: string }; limit: number;
  }) {
    if (input.bytes.byteLength > input.limit || input.bytes.byteLength !== input.expected.bytes) return result === false;
    return result === (createHash('sha256').update(input.bytes).digest('hex') === input.expected.sha256);
  },
};
