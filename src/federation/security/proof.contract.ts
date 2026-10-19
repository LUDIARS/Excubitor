import { createHash, createPublicKey, verify } from 'node:crypto';
import type { MeshProof } from './proof.js';

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export default {
  post: (result: boolean, input: { publicKey: string; parts: MeshProof; signature: string }) => {
    if (!result) return true;
    const p = input.parts;
    const payload = JSON.stringify(['excubitor-cr-v1', p.method.toUpperCase(), p.path,
      p.timestamp, p.nonce, digest(p.body), p.audience, digest(p.token)]);
    const key = createPublicKey(input.publicKey);
    return (key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(payload, 'utf8'), key,
      Buffer.from(input.signature, 'base64url'))) || 'unbound or invalid workload proof accepted';
  },
};
