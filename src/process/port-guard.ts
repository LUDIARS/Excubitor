/**
 * 起動前の宣言ポート占有の解消。
 *
 * SRP: 「catalog がこのサービスのものと宣言した port を、いま誰が握っているか」を
 * 見て、取りこぼした旧インスタンスを止めるところまで。spawn 自体は manager.ts、
 * リスナー列挙は scanner/ports.ts が持つ。
 *
 * なぜ必要か: spawnService は spawn 前に port を一切見ないため、supervisor 再起動等で
 * pid の追跡を失った旧インスタンスが port を握ったままだと、新プロセスは EADDRINUSE で
 * 即死し `could not be verified after breakaway spawn` になる。**旧プロセスは生きたまま**
 * なので、外からは「再起動したのに古いコードが動き続ける」という最も気づきにくい形になる
 * (2026-08-04 に Revisor で 2 回発生。health は 200 を返すので成功に見える)。
 *
 * 方針 (neco 裁定 2026-08-04): 宣言ポートに居る管理外プロセスは「取りこぼした自分」と
 * みなして停止してから起動する。restart が常に実体を入れ替えることを優先する。
 */

import { createNamedLogger } from '../shared/logger.js';
import { listListeners } from '../scanner/ports.js';

const logger = createNamedLogger('excubitor.process.port-guard');

/** ポート解放を待つ既定の上限と間隔。 */
const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;
const DEFAULT_RELEASE_INTERVAL_MS = 250;

export interface DeclaredPortGuardDeps {
  /** pid ツリーの停止。 manager.ts の treeKill を注入する (循環 import を避けるため必須)。 */
  kill: (pid: number) => Promise<void>;
  listeners?: () => Promise<Array<{ port: number; pids: number[] }>>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

export type DeclaredPortGuardResult =
  /** 誰も握っていない (そのまま起動してよい)。 */
  | { kind: 'free' }
  /** 自分が管理している pid が握っている (起動済みとして扱う)。 */
  | { kind: 'managed'; pid: number }
  /** 管理外の占有を止めた。 */
  | { kind: 'reclaimed'; stoppedPids: number[] };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 宣言ポートの占有を解消する。
 *
 * `managedPid` は supervisor が把握している当該サービスの pid (無ければ undefined)。
 * それが占有者に含まれるなら停止せず `managed` を返し、呼び出し側が冪等に扱えるようにする。
 */
export async function clearDeclaredPort(
  code: string,
  port: number | null | undefined,
  managedPid: number | undefined,
  deps: DeclaredPortGuardDeps,
): Promise<DeclaredPortGuardResult> {
  if (port == null) return { kind: 'free' };

  const listeners = deps.listeners ?? listListeners;
  const kill = deps.kill;
  const sleep = deps.sleep ?? delay;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_RELEASE_INTERVAL_MS;

  const occupied = (await listeners()).find((entry) => entry.port === port);
  if (!occupied || occupied.pids.length === 0) return { kind: 'free' };

  if (managedPid !== undefined && occupied.pids.includes(managedPid)) {
    return { kind: 'managed', pid: managedPid };
  }

  logger.warn(
    { code, port, pids: occupied.pids },
    'declared port is held by an unmanaged process; stopping it before spawn',
  );

  const stoppedPids: number[] = [];
  for (const pid of occupied.pids) {
    try {
      await kill(pid);
      stoppedPids.push(pid);
    } catch (error) {
      // 落とせなかった pid は下の解放待ちで検出され、そこで fail-closed する。
      logger.warn({ code, port, pid, err: error }, 'failed to stop the port holder');
    }
  }

  // taskkill /T は非同期に効くため、解放を確認してから spawn する。ここで待たないと
  // 「止めたのに EADDRINUSE」という同じ症状を別経路で作る。
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const still = (await listeners()).find((entry) => entry.port === port);
    if (!still || still.pids.length === 0) return { kind: 'reclaimed', stoppedPids };
    if (Date.now() >= deadline) {
      throw new Error(
        `service ${code}: port ${port} is still held by pid ${still.pids.join(', ')} after stopping it`,
      );
    }
    await sleep(intervalMs);
  }
}
