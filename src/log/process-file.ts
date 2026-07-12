/**
 * detached 子プロセスのログを「パイプ」ではなく「ファイル」へ落とすための補助。
 *
 * 背景 (#84): runtime=node/app の子は detached + unref で spawn し、 Excubitor 自身が
 * 再起動/終了してもサービスを道連れにしない設計。 しかし子の stdout/stderr を親が pipe で
 * 読んでいると、 親 (Excubitor) が落ちた瞬間に read 端が閉じ、 子の次の write が EPIPE で
 * 即死する。 そこで子の出力を親所有のファイル fd に向け (= 親が死んでも write 先は生存)、
 * ライブログ/エラー検知は backend の ProcessLogTail が読み、log bus に publish する。
 *
 * - channel ごとに `<dir>/<code>.out.log` / `<code>.err.log` を append open
 * - supervisor は append fd の open/close だけを所有し、ログ本文をメモリへ読み込まない
 * - 既定 dir は `data/process-logs` (EXCUBITOR_PROCESS_LOG_DIR で上書き可)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import type { Channel } from './bus.js';

const logger = createNamedLogger('excubitor.process-file');

export function processLogDir(): string {
  return path.resolve(
    process.env.EXCUBITOR_PROCESS_LOG_DIR || path.join(process.cwd(), 'data', 'process-logs'),
  );
}

export function processLogFile(code: string, channel: Channel): string {
  const suffix = channel === 'stderr' ? 'err' : 'out';
  return path.join(processLogDir(), `${code}.${suffix}.log`);
}

interface Handle {
  stop: () => void;
}

const active = new Map<string, Handle>();

/**
 * code 用のログファイルを open する。子 spawn の stdio に渡す fd を返す。
 * fd の所有者は本モジュール (close は stopProcessLog で行う)。
 */
export function startProcessLog(code: string): { stdoutFd: number; stderrFd: number } {
  stopProcessLog(code); // 二重起動防止 (前回の fd を閉じる)
  fs.mkdirSync(processLogDir(), { recursive: true });
  const outPath = processLogFile(code, 'stdout');
  const errPath = processLogFile(code, 'stderr');
  const stdoutFd = fs.openSync(outPath, 'a');
  let stderrFd: number | undefined;
  try {
    stderrFd = fs.openSync(errPath, 'a');
    const ownedStderrFd = stderrFd;
    active.set(code, {
      stop: () => {
        try { fs.closeSync(stdoutFd); } catch { /* noop */ }
        try { fs.closeSync(ownedStderrFd); } catch { /* noop */ }
      },
    });
    logger.info({ code, out: outPath, err: errPath }, 'process log files opened (detached-safe)');
    return { stdoutFd, stderrFd: ownedStderrFd };
  } catch (error) {
    try { fs.closeSync(stdoutFd); } catch { /* preserve the open/registration error */ }
    if (stderrFd !== undefined) {
      try { fs.closeSync(stderrFd); } catch { /* preserve the open/registration error */ }
    }
    active.delete(code);
    throw error;
  }
}

/** code の append fd を閉じる。 */
export function stopProcessLog(code: string): void {
  const h = active.get(code);
  if (!h) return;
  h.stop();
  active.delete(code);
}

/** test 用: 現在 append fd を所有している code 一覧。 */
export function _activeProcessLogs(): string[] {
  return Array.from(active.keys());
}
