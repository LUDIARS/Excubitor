/**
 * local-control supervisor 自身のログ。
 *
 * Windows では supervisor を窓無しランチャー経由の Scheduled Task で起動するため、stdout/stderr は
 * どこにも繋がらない。そのままでは supervisor が落ちても理由が残らない (2026-10-29 に過負荷の中で
 * 落ち、Task の再試行を使い切って朝まで停止した)。ログをファイルへも書き、想定外の例外で終わる
 * ときは理由を同期書き込みしてから終了する。終了は OS の Task に再起動させるためで、握り潰さない。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pino, { type Logger } from 'pino';

export const SUPERVISOR_LOG_FILE = 'excubitor-supervisor.log';

export function supervisorLogPath(rootDir: string): string {
  return join(rootDir, 'data', 'process-logs', SUPERVISOR_LOG_FILE);
}

/** stdout (foreground 起動時) と supervisor ログファイルの両方へ書く logger。 */
export function createSupervisorLogger(rootDir: string, level = process.env.EXCUBITOR_LOG_LEVEL ?? 'info'): Logger {
  const path = supervisorLogPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  return pino(
    { level, base: { name: 'excubitor.supervisor', pid: process.pid } },
    pino.multistream([
      { level: 'trace', stream: process.stdout },
      // 終了直前の fatal を確実に残すため同期書き込みにする。supervisor のログ量は少ない。
      { level: 'trace', stream: pino.destination({ dest: path, append: true, sync: true }) },
    ]),
  );
}

export interface FatalHandlerTarget {
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

function describe(value: unknown): { err: string; stack?: string } {
  if (value instanceof Error) return { err: value.message, stack: value.stack };
  return { err: String(value) };
}

/** 想定外の例外・拒否を記録してから exit(1) する。Task の再起動に任せる。 */
export function installSupervisorFatalHandlers(
  target: FatalHandlerTarget,
  logger: Pick<Logger, 'fatal'>,
  exit: (code: number) => void,
): void {
  target.on('uncaughtException', (error) => {
    logger.fatal(describe(error), 'supervisor uncaught exception; exiting for OS restart');
    exit(1);
  });
  target.on('unhandledRejection', (reason) => {
    logger.fatal(describe(reason), 'supervisor unhandled rejection; exiting for OS restart');
    exit(1);
  });
}
