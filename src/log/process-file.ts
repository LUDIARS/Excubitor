/**
 * detached 子プロセスのログを「パイプ」ではなく「ファイル」へ落とすための補助。
 *
 * 背景 (#84): runtime=node/app の子は detached + unref で spawn し、 Excubitor 自身が
 * 再起動/終了してもサービスを道連れにしない設計。 しかし子の stdout/stderr を親が pipe で
 * 読んでいると、 親 (Excubitor) が落ちた瞬間に read 端が閉じ、 子の次の write が EPIPE で
 * 即死する。 そこで子の出力を親所有のファイル fd に向け (= 親が死んでも write 先は生存)、
 * ライブログ/エラー検知は本モジュールがそのファイルを tail して log bus に publish する。
 *
 * - channel ごとに `<dir>/<code>.out.log` / `<code>.err.log` を append open
 * - POLL_MS ごとに offset から増分を読み、 行単位で publish (= 既存 bus 購読者がそのまま動く)
 * - 既定 dir は `data/process-logs` (EXCUBITOR_PROCESS_LOG_DIR で上書き可)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { publish, type Channel } from './bus.js';

const logger = createNamedLogger('excubitor.process-file');

const POLL_MS = 1000;

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
 * code 用のログファイルを open し、 tail を開始する。 子 spawn の stdio に渡す fd を返す。
 * fd の所有者は本モジュール (close は stopProcessLog で行う)。
 */
export function startProcessLog(code: string): { stdoutFd: number; stderrFd: number } {
  stopProcessLog(code); // 二重起動防止 (前回の fd / tail を畳む)
  fs.mkdirSync(processLogDir(), { recursive: true });
  const outPath = processLogFile(code, 'stdout');
  const errPath = processLogFile(code, 'stderr');
  const stdoutFd = fs.openSync(outPath, 'a');
  const stderrFd = fs.openSync(errPath, 'a');

  const offsets: Record<Channel, number> = { stdout: safeSize(outPath), stderr: safeSize(errPath) };
  const bufs: Record<Channel, string> = { stdout: '', stderr: '' };

  const timer = setInterval(() => {
    drain(code, 'stdout', outPath, offsets, bufs);
    drain(code, 'stderr', errPath, offsets, bufs);
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  active.set(code, {
    stop: () => {
      clearInterval(timer);
      try { fs.closeSync(stdoutFd); } catch { /* noop */ }
      try { fs.closeSync(stderrFd); } catch { /* noop */ }
    },
  });
  logger.info({ code, out: outPath, err: errPath }, 'process log files opened (detached-safe)');
  return { stdoutFd, stderrFd };
}

/** code の tail を止めて fd を閉じる。 */
export function stopProcessLog(code: string): void {
  const h = active.get(code);
  if (!h) return;
  h.stop();
  active.delete(code);
}

function safeSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function drain(
  code: string,
  channel: Channel,
  file: string,
  offsets: Record<Channel, number>,
  bufs: Record<Channel, string>,
): void {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < offsets[channel]) { offsets[channel] = 0; bufs[channel] = ''; }
  if (size === offsets[channel]) return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const need = size - offsets[channel];
    const buffer = Buffer.alloc(need);
    fs.readSync(fd, buffer, 0, need, offsets[channel]);
    offsets[channel] = size;
    bufs[channel] += buffer.toString('utf8');
    let nl: number;
    while ((nl = bufs[channel].indexOf('\n')) !== -1) {
      const line = bufs[channel].slice(0, nl).replace(/\r$/, '');
      bufs[channel] = bufs[channel].slice(nl + 1);
      if (line.length > 0) void publish({ service_code: code, channel, ts: new Date(), line });
    }
  } catch (err) {
    logger.warn({ code, channel, err: (err as Error).message }, 'process log drain failed');
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* noop */ } }
  }
}

/** test 用: 現在 tail 中の code 一覧。 */
export function _activeProcessLogs(): string[] {
  return Array.from(active.keys());
}
