/**
 * Log line バス。 ProcessManager / docker tail / 任意ソースから集まる line を中央集約し、
 * 永続化 (process_logs テーブル) と SSE fan-out と error_detector へ配信する。
 */
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';

const logger = pino({ name: 'excubitor.logbus' });

export type Channel = 'stdout' | 'stderr';

export interface LogLine {
  service_code: string;
  channel: Channel;
  ts: Date;
  line: string;
}

type Subscriber = (line: LogLine) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export async function publish(line: LogLine): Promise<void> {
  // sub に配信
  for (const s of subscribers) {
    try { s(line); } catch (err) {
      logger.warn({ err: (err as Error).message }, 'subscriber threw');
    }
  }
  // 永続化 (fire-and-forget、 失敗はログのみ)
  void persistLine(line).catch((err: unknown) =>
    logger.warn({ err: (err as Error).message, code: line.service_code }, 'persist failed'),
  );
}

async function persistLine(line: LogLine): Promise<void> {
  await db.execute(sql`
    INSERT INTO process_logs (service_instance_id, ts, level, line)
    SELECT si.id, ${line.ts.toISOString()}::timestamptz, ${inferLevel(line)}, ${truncate(line.line, 4000)}
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${line.service_code}
    LIMIT 1
  `);
}

function inferLevel(line: LogLine): string | null {
  if (line.channel === 'stderr') return 'error';
  const l = line.line.toLowerCase();
  if (/\b(fatal)\b/.test(l)) return 'fatal';
  if (/\b(error|err|exception|traceback)\b/.test(l)) return 'error';
  if (/\b(warn|warning)\b/.test(l)) return 'warn';
  if (/\b(info)\b/.test(l)) return 'info';
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '…' : s;
}
