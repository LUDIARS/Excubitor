import pino from 'pino';
import { detectLogSafeMode } from '../safe-mode.js';

// LogSafeMode では自身の出力も warn へ落とす (process-logs への書き込み圧を最小化)。
// EXCUBITOR_LOG_LEVEL 明示時はそちらを優先 (切り分け時に info へ戻せる)。
const level = process.env.EXCUBITOR_LOG_LEVEL ?? (detectLogSafeMode() ? 'warn' : 'info');
export const rootLogger = pino({ level });

export function createNamedLogger(name: string) {
  return rootLogger.child({ name });
}

