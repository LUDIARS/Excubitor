/** ProcessManager / docker tail / file tail の行をライブ購読者へ配信する log bus。 */
import { createNamedLogger } from '../shared/logger.js';
import { appendLogLine } from './ring-buffer.js';

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
  appendLogLine(line);
  for (const subscriber of subscribers) {
    try {
      subscriber(line);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'subscriber threw');
    }
  }
}
