/**
 * サービスの起動記録を、そのサービス自身のプロセスログ (`data/process-logs/<code>.{out,err}.log`)
 * へ追記する。
 *
 * プロセスログにはサービスの出力しか入らないため、ログ画面からは「どこからが今回の起動か」
 * 「どのコマンドで起動し、どの pid になったか」が読めず、起動失敗 (ビルド失敗・spawn 即死) は
 * supervisor 自身の pino にしか残らなかった。起動のたびに区切りと結果をここへ書き、
 * ProcessLogTail → log bus → error-detector の既存経路にそのまま乗せる。
 *
 * - 行頭は必ず `[excubitor]`。サービスの出力と見分けられる。
 * - 失敗は stderr 側に `[excubitor-start-failure]` 付きで書く。既定のエラールール
 *   (`auto_fix/seed.ts` の "Excubitor start failure") がこの印でエラータスクを作る。
 * - 書き込みは best-effort。ログが書けなくても起動処理は止めない。
 */
import fs from 'node:fs';
import { createNamedLogger } from '../shared/logger.js';
import { processLogFile } from './process-file.js';

const logger = createNamedLogger('excubitor.lifecycle-log');

/** 起動失敗行の印。エラールールの pattern と一致させる。 */
export const START_FAILURE_MARKER = '[excubitor-start-failure]';

/** 失敗詳細 (ビルド出力など) を何文字まで載せるか。長い出力は末尾を残す。 */
const MAX_DETAIL_CHARS = 2000;

export type LifecycleEvent =
  | { kind: 'build-start'; reason: string; command: string; cwd: string }
  | { kind: 'build-failed'; reason: string; command: string; exitCode: number | null; output: string }
  | { kind: 'start'; command: string; cwd: string | undefined; version: string; restartCount: number; strategy: string }
  | { kind: 'spawned'; pid: number | null; strategy: string }
  | { kind: 'start-failed'; message: string; retainedPid: number | null };

/** イベントを 1 件以上の行へ整形する。失敗系は stderr、それ以外は stdout へ書く。 */
export function formatLifecycleEvent(
  event: LifecycleEvent,
  now: Date = new Date(),
): { channel: 'stdout' | 'stderr'; lines: string[] } {
  const head = `[excubitor] ${now.toISOString()}`;
  switch (event.kind) {
    case 'build-start':
      return {
        channel: 'stdout',
        lines: [`${head} build start reason=${event.reason} command=${quote(event.command)} cwd=${quote(event.cwd)}`],
      };
    case 'build-failed':
      return {
        channel: 'stderr',
        lines: [
          `${head} ${START_FAILURE_MARKER} build failed reason=${event.reason} exit=${event.exitCode ?? 'null'} command=${quote(event.command)}`,
          ...indentDetail(event.output),
        ],
      };
    case 'start':
      return {
        channel: 'stdout',
        lines: [
          `${head} ===== start strategy=${event.strategy} restart=${event.restartCount} version=${event.version}`,
          `${head} command=${quote(event.command)} cwd=${quote(event.cwd ?? '(default)')}`,
        ],
      };
    case 'spawned':
      return {
        channel: 'stdout',
        lines: [`${head} spawned pid=${event.pid ?? '?'} strategy=${event.strategy}`],
      };
    case 'start-failed':
      return {
        channel: 'stderr',
        lines: [
          `${head} ${START_FAILURE_MARKER} start failed${event.retainedPid === null ? '' : ` (pid ${event.retainedPid} may still be running)`}: ${firstLine(event.message)}`,
          ...indentDetail(restLines(event.message)),
        ],
      };
  }
}

/** code のプロセスログへイベントを追記する。失敗しても例外を投げない。 */
export function appendLifecycleEvent(code: string, event: LifecycleEvent): void {
  const { channel, lines } = formatLifecycleEvent(event);
  try {
    fs.appendFileSync(processLogFile(code, channel), lines.map((line) => `${line}\n`).join(''));
  } catch (err) {
    logger.warn({ code, kind: event.kind, err: (err as Error).message }, 'failed to append lifecycle log');
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function restLines(text: string): string {
  const index = text.search(/\r?\n/);
  return index === -1 ? '' : text.slice(index).replace(/^\r?\n/, '');
}

/** 詳細を末尾 MAX_DETAIL_CHARS 文字に丸め、行頭を `[excubitor]   ` で字下げする。 */
function indentDetail(detail: string): string[] {
  const trimmed = detail.trim();
  if (!trimmed) return [];
  const tail = trimmed.length > MAX_DETAIL_CHARS ? `…${trimmed.slice(-MAX_DETAIL_CHARS)}` : trimmed;
  return tail.split(/\r?\n/).map((line) => `[excubitor]   ${line}`);
}
