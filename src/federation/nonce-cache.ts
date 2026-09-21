/**
 * 署名付き要求の nonce を覚えておき、 同じ要求の再送を拒否する。
 *
 * 時刻窓 (request-signature.ts の SIGNATURE_MAX_SKEW_MS) の外の要求はそもそも通らないので、
 * nonce はその窓の 2 倍だけ覚えていれば足りる。 メモリのみ (Excubitor の再起動で消えるが、
 * 再起動をまたぐ再送は時刻窓がほぼ塞ぐ)。
 */

/** @implements SPEC-FEDERATION-MUTUAL-AUTH */

export interface NonceCache {
  /** 未使用なら記録して true、 使用済みなら false。 */
  remember: (nonce: string, now: number) => boolean;
  size: () => number;
}

export function createNonceCache(retentionMs: number): NonceCache {
  const seen = new Map<string, number>();
  let lastPrune = 0;

  const prune = (now: number): void => {
    for (const [nonce, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(nonce);
    }
    lastPrune = now;
  };

  return {
    remember: (nonce, now) => {
      if (now - lastPrune > retentionMs / 4) prune(now);
      const expiresAt = seen.get(nonce);
      if (expiresAt !== undefined && expiresAt > now) return false;
      seen.set(nonce, now + retentionMs);
      return true;
    },
    size: () => seen.size,
  };
}
