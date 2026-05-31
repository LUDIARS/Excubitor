/**
 * Log line 繝舌せ縲・ProcessManager / docker tail / 莉ｻ諢上た繝ｼ繧ｹ縺九ｉ髮・∪繧・line 繧剃ｸｭ螟ｮ髮・ｴ・＠縲・
 * 豌ｸ邯壼喧 (process_logs 繝・・繝悶Ν) 縺ｨ SSE fan-out 縺ｨ error_detector 縺ｸ驟堺ｿ｡縺吶ｋ縲・
 */
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';

const logger = createNamedLogger('excubitor.logbus');

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
  // sub 縺ｫ驟堺ｿ｡
  for (const s of subscribers) {
    try { s(line); } catch (err) {
      logger.warn({ err: (err as Error).message }, 'subscriber threw');
    }
  }
  // 豌ｸ邯壼喧 (fire-and-forget縲・螟ｱ謨励・繝ｭ繧ｰ縺ｮ縺ｿ)
  void persistLine(line).catch((err: unknown) =>
    logger.warn({ err: (err as Error).message, code: line.service_code }, 'persist failed'),
  );
}

async function persistLine(line: LogLine): Promise<void> {
  // NOTE: Excubitor 縺ｮ process_logs 繧・Concordia 縺ｧ縺ｯ service_instance_logs 縺ｫ rename
  // (Concordia 譌｢蟄倥・ processes (managed processes) 逕ｱ譚･縺ｮ process_logs 縺ｨ蛹ｺ蛻･縺吶ｋ縺溘ａ)縲・
  db().run(sql`
    INSERT INTO service_instance_logs (service_instance_id, ts, level, line)
    SELECT si.id, ${line.ts.getTime()}, ${inferLevel(line)}, ${truncate(line.line, 4000)}
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
  return s.length > max ? s.slice(0, max - 3) + '窶ｦ' : s;
}


