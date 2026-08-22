/**
 * `GET /containers/{id}/stats?stream=false` からメモリ / CPU を算出する。
 * 旧 `docker stats --no-stream --format '{{json .}}'` 置換 (子プロセスを spawn しない)。
 *
 * 値の算出は docker CLI と同じ式:
 *   mem used = memory_stats.usage - inactive_file (cgroup v2) / - total_inactive_file (v1)
 *   cpu %    = Δcpu_total / Δsystem_cpu * online_cpus * 100
 */

import { engineGetJson } from './engine-client.js';
import { listContainers } from './containers.js';

export interface DockerMemStat {
  /** コンテナ名 (catalog の container_names と突合する)。 */
  name: string;
  container: string;
  usedBytes: number | null;
  limitBytes: number | null;
  /** メモリ使用率 (%)、 算出できなければ null。 */
  percent: number | null;
  /** CPU 使用率 (%)、 算出できなければ null。 */
  cpuPercent: number | null;
}

/** Engine API の stats 応答 (必要なフィールドのみ)。 */
export interface ApiStats {
  id?: string;
  name?: string;
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
}

export function statFromApi(raw: ApiStats): DockerMemStat {
  const mem = raw.memory_stats ?? {};
  const inactive = mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? 0;
  const used = mem.usage != null ? Math.max(0, mem.usage - inactive) : null;
  const limit = mem.limit != null && mem.limit > 0 ? mem.limit : null;
  const percent = used != null && limit != null ? round2((used / limit) * 100) : null;

  const cpuNow = raw.cpu_stats?.cpu_usage?.total_usage;
  const cpuPrev = raw.precpu_stats?.cpu_usage?.total_usage;
  const sysNow = raw.cpu_stats?.system_cpu_usage;
  const sysPrev = raw.precpu_stats?.system_cpu_usage;
  let cpuPercent: number | null = null;
  if (cpuNow != null && cpuPrev != null && sysNow != null && sysPrev != null) {
    const cpuDelta = cpuNow - cpuPrev;
    const sysDelta = sysNow - sysPrev;
    const cpus = raw.cpu_stats?.online_cpus ?? 1;
    // sysDelta <= 0 は 2 点目が採れていない (one-shot 応答など) 状態で、 「CPU 0%」 とは違う。
    // 0 を返すと cpu-alert の sustained 判定に偽の低負荷サンプルが混ざるため null (=不明) にする。
    if (sysDelta > 0) cpuPercent = round2((Math.max(0, cpuDelta) / sysDelta) * cpus * 100);
  }

  return {
    name: (raw.name ?? '').replace(/^\//, '').trim(),
    container: raw.id ?? '',
    usedBytes: used,
    limitBytes: limit,
    percent,
    cpuPercent,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** stats を同時に張る本数の上限。 */
const STATS_CONCURRENCY = 4;

/**
 * `Promise.allSettled` と同じ結果配列 (入力順) を返しつつ、 同時実行数を limit で抑える。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(item) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * running コンテナ全部の stats を並列取得して名前 → stat の Map にする。
 * 一覧取得に失敗したら null (旧 sampler と同じ契約)。 個別 stats の失敗はそのコンテナを欠落させるだけ。
 */
export async function sampleDockerStats(timeoutMs = 15000): Promise<Map<string, DockerMemStat> | null> {
  let containers;
  try {
    containers = (await listContainers()).filter((c) => c.state === 'running');
  } catch {
    return null;
  }
  // one-shot は付けない。 付けると precpu_stats が空のまま返り CPU% が算出できなくなる。
  // stream=false 単体なら daemon 側が 2 点採ってから返すため docker CLI と同じ delta が得られる。
  // ただし 1 本あたり ~1 秒 daemon 側で待つため、 全コンテナを同時に張ると名前付きパイプへの
  // 同時接続が跳ね上がる (本 PR の目的であるハンドル残留削減に逆行する)。 同時数を絞る。
  const results = await mapWithConcurrency(containers, STATS_CONCURRENCY, (c) =>
    engineGetJson<ApiStats>(`/containers/${encodeURIComponent(c.id)}/stats?stream=false`, timeoutMs),
  );
  const map = new Map<string, DockerMemStat>();
  results.forEach((r, i) => {
    const c = containers[i];
    if (r.status !== 'fulfilled' || !c) return;
    const stat = statFromApi(r.value);
    const names = c.names.length > 0 ? c.names : [stat.name];
    for (const n of names) if (n) map.set(n, { ...stat, name: n });
  });
  return map;
}
