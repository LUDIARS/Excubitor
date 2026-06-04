/**
 * 起動順序の決定 (pure). 依存の浅いものから先に上げる:
 *   tier 0: infra (postgres / redis / minio / mailpit)
 *   tier 1: Cernere (認証基盤)
 *   tier 2: Corpus (Hub)
 *   tier 3: corpus submodule 依存 (VantanHub 等)
 *   tier 5: その他 leaf サービス
 *
 * tier 単位でまとめて起動し、 tier 間にだけ待ちを入れる (orchestrator 側)。
 * DB 非依存なので単体テスト可能。
 */

import type { Service } from '../catalog/loader.js';

const TIER_BY_PROJECT: Record<string, number> = {
  infra: 0,
  cernere: 1,
  corpus: 2,
  vantanhub: 3,
};

export function startTier(svc: Pick<Service, 'project_code' | 'code'>): number {
  const key = svc.project_code ?? svc.code;
  return TIER_BY_PROJECT[key] ?? 5;
}

export interface OrderedTier {
  tier: number;
  services: Service[];
}

/**
 * codes に含まれる service を tier 昇順にまとめる。
 * 同 tier 内は catalog 順を維持する。
 */
export function orderForStart(services: Service[], codes: string[]): OrderedTier[] {
  const want = new Set(codes);
  const buckets = new Map<number, Service[]>();
  for (const svc of services) {
    if (!want.has(svc.code)) continue;
    const tier = startTier(svc);
    const arr = buckets.get(tier) ?? [];
    arr.push(svc);
    buckets.set(tier, arr);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([tier, svcs]) => ({ tier, services: svcs }));
}

/** 停止は起動の逆順 (leaf を先に落とし、 依存基盤を後に落とす)。 */
export function orderForStop(services: Service[], codes: string[]): Service[] {
  return orderForStart(services, codes)
    .reverse()
    .flatMap((t) => t.services);
}
