/**
 * managed service をどの経路で起動するかの判定。正本: spec/plan/design.md §17.6。
 *
 * win32 は **必ず** Job 外 (job-breakaway) で起動する。supervisor の直接の子として `detached` なしで
 * 起動すると、Node (libuv) が子を「親だけがハンドルを持つ KILL_ON_JOB_CLOSE の Job」に入れるため、
 * supervisor が終わると (`Stop-ScheduledTask` / 未捕捉例外) 全サービスが一斉に消える (design.md §17.6)。
 * child 起動 (supervisor の直接の子) は POSIX 専用で、win32 で選ぶ手段は持たない。
 *
 * 以前は `EXCUBITOR_SPAWN_STRATEGY=child` で win32 でも child 起動を選べたが、ユーザ環境変数に
 * 残った `child` が breakaway を黙って無効にし続け、supervisor 再起動のたびに Concordia /
 * Revisor や autostart 外の Web サービスが巻き添えで落ちた (2026-09-06 / 2026-09-19)。
 * 上書き経路ごと廃止し、値が残っていても従わない (従わないことだけ warn で観測可能にする)。
 */
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.process.spawn-strategy');

/** 廃止した上書き env。残骸の検出にだけ使う。 */
export const RETIRED_SPAWN_STRATEGY_ENV = 'EXCUBITOR_SPAWN_STRATEGY';

let retiredOverrideReported = false;

/** 起動を supervisor の Job 外へ出すか。win32 だけが true。 */
export function spawnsOutsideJob(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  reportRetiredOverride(env);
  return platform === 'win32';
}

function reportRetiredOverride(env: NodeJS.ProcessEnv): void {
  const value = env[RETIRED_SPAWN_STRATEGY_ENV];
  if (retiredOverrideReported || value === undefined || value === '') return;
  retiredOverrideReported = true;
  logger.warn(
    { env: RETIRED_SPAWN_STRATEGY_ENV, value },
    'spawn strategy override is retired and ignored; remove it from the environment',
  );
}
