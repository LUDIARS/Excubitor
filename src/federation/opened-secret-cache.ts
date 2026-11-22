/**
 * remote_peers の機密列を開いた結果を、保存値 (暗号文) ごとに覚える。
 *
 * 暗号文の復号は scryptSync で鍵を導出するので 1 件で数十〜百 ms かかり、主スレッドを止める。
 * 連合の状態キャッシュ (`payload-cache.ts`) は 10 秒ごとに `listPeers()` で全ピアの token と
 * CF secret を開き直していて、2026-11-22 のプロファイルでは 60 秒中 5.2 秒をこれに使っていた。
 * 10 秒ごとに約 0.9 秒続けて止まるので、supervisor の 1 秒の health 確認を落とす主因になっていた。
 *
 * 保存値は暗号化のたびに salt が変わるので、同じ保存値なら開いた結果も同じ。値を変えると保存値が
 * 変わり、覚えた結果には当たらない (取り消し・更新は即座に効く)。復号できなかった結果 (null) も
 * 覚える: master 鍵はプロセス内で固定 (`master-key.ts` の cachedKeys) なので、同じ保存値を何度
 * 開いても結果は変わらない。鍵を差し替えるには再起動が要り、そのとき覚えた結果も消える。
 *
 * @implements SPEC-EX-PEER-SECRET-CACHE
 */

export const OPENED_SECRET_CACHE_MAX_ENTRIES = 256;

export type SecretOpener = (stored: string) => string | null;

export interface OpenedSecretCache {
  open(stored: string | null): string | null;
  readonly size: number;
}

export function createOpenedSecretCache(
  opener: SecretOpener,
  maxEntries = OPENED_SECRET_CACHE_MAX_ENTRIES,
): OpenedSecretCache {
  const entries = new Map<string, string | null>();
  return {
    open(stored) {
      if (stored == null) return null;
      if (entries.has(stored)) return entries.get(stored) ?? null;
      const opened = opener(stored);
      entries.set(stored, opened);
      // Map は挿入順なので先頭が最も古い。消えたピアの暗号文もいずれ押し出される。
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return opened;
    },
    get size() {
      return entries.size;
    },
  };
}
