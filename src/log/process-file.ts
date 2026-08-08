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

/**
 * open 時ローテーションのサイズ上限 (バイト)。 EXCUBITOR_PROCESS_LOG_MAX_MB で上書き可。
 * 設計は spec/plan/log-store.md §3 [retention] 「process-logs 生ファイル: サイズ上限
 * ローテーション (既定 32MB × 2 世代)」 / §5 Phase 3。
 *
 * ローテーションは open (= サービス起動/再起動) 時のみ。 稼働中の子は fd を直接
 * 持っているため、 走行中の rename/truncate は Windows では安全にできない
 * (rename 後も子は旧 inode に書き続け、 truncate は sparse file を作る)。
 * 長期稼働サービスは再起動のたびに上限へ丸められる。
 *
 * 退避時、 tail が未読の行は取りこぼす (`.1` は tail 対象外)。 上限は tail の
 * 追従速度より十分大きい前提で、 取りこぼしはクラッシュ安全性より優先度が低い。
 */
const DEFAULT_MAX_LOG_MB = 32;

function maxLogBytes(): number {
  const raw = Number(process.env.EXCUBITOR_PROCESS_LOG_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LOG_MB;
  return Math.floor(mb * 1024 * 1024);
}

/**
 * 上限超過ログを `<file>.1` へ退避する (世代 1 のみ、 旧 .1 は破棄)。
 * 失敗しても spawn を止めない (append 継続が最優先)。
 *
 * catalog の `code` は未検証の文字列 (各リポの断片 YAML 由来) で、 `../` を含むと
 * `processLogFile()` の path.join がログ dir の外を指す。 open/append だけなら
 * 被害は限定的だが、 ここは rm/rename する破壊的経路なので dir 内に閉じ込める。
 */
function rotateIfOversized(filePath: string, limitBytes: number): void {
  const dir = processLogDir();
  // dir 直下のファイルであること。 `..` / サブディレクトリを含む code はここで弾く。
  if (path.relative(dir, filePath) !== path.basename(filePath)) {
    logger.warn({ file: filePath, dir }, 'skipping rotation for path outside the process log dir');
    return;
  }
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return; // 初回起動などファイル無しは対象外
  }
  if (size <= limitBytes) return;
  const archivePath = `${filePath}.1`;
  try {
    fs.rmSync(archivePath, { force: true });
    fs.renameSync(filePath, archivePath);
    logger.info({ file: filePath, archived: archivePath, bytes: size }, 'process log rotated');
  } catch (error) {
    // ProcessLogTail 等の読者は FILE_SHARE_DELETE 付きで開くため通常は成功する。
    // 別プロセスがロックしている場合のみここに落ちる (append 継続を優先)。
    logger.warn(
      { file: filePath, bytes: size, err: (error as Error).message },
      'process log rotation failed (append continues)',
    );
  }
}

export function processLogDir(): string {
  return path.resolve(
    process.env.EXCUBITOR_PROCESS_LOG_DIR || path.join(process.cwd(), 'data', 'process-logs'),
  );
}

export function processLogFile(code: string, channel: Channel): string {
  const suffix = channel === 'stderr' ? 'err' : 'out';
  return path.join(processLogDir(), `${code}.${suffix}.log`);
}

/**
 * breakaway spawn 用: ログファイルのパスだけを用意する (fd は開かない)。
 * 短命 launcher が append fd を開いて実プロセスへ継承させるため、supervisor は
 * fd を所有しない (supervisor の死とログ書き込みを完全に切り離す)。
 *
 * fd は持たないが、 ローテーションの契機は startProcessLog と同じ 「open
 * (= サービス起動/再起動) 時のみ」 を維持する。 ここで回さないと win32 既定の
 * breakaway 経路だけ上限 (EXCUBITOR_PROCESS_LOG_MAX_MB) が効かず無制限に増える。
 */
export function ensureProcessLogPaths(code: string): { stdoutPath: string; stderrPath: string } {
  fs.mkdirSync(processLogDir(), { recursive: true });
  const stdoutPath = processLogFile(code, 'stdout');
  const stderrPath = processLogFile(code, 'stderr');
  const limit = maxLogBytes();
  rotateIfOversized(stdoutPath, limit);
  rotateIfOversized(stderrPath, limit);
  return { stdoutPath, stderrPath };
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
  const limit = maxLogBytes();
  rotateIfOversized(outPath, limit);
  rotateIfOversized(errPath, limit);
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
