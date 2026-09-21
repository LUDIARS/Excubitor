/**
 * 同時実行数を上限付きで非同期 map する。
 *
 * 監視ループは 90 前後のサービスへ probe を投げる。 全件を同時に投げると 1 秒の間に
 * socket / fetch / 子プロセスが山になり、 監視自体が負荷の山を作る。 上限を置いて均す。
 * 結果の順序は入力順を保つ。 fn の例外は呼び出し側へそのまま伝える (握りつぶさない)。
 */

/** @implements SPEC-MONITOR-LIGHTWEIGHT */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithLimit: limit must be a positive integer (got ${limit})`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
