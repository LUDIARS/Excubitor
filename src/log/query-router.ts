import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { sharedLogsRoot } from './logs-root.js';
import { queryLogs, type LogQuery, type QueriedLogLine } from './query-engine.js';

const logger = createNamedLogger('excubitor.log-query');
const MAX_CONCURRENT_QUERIES = 2;

const QueryParamsSchema = z.object({
  codes: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  contains: z.string().max(1_000).optional(),
  limit: z.coerce.number().int().positive().max(5_000).default(300),
});

class QueryGate {
  private active = 0;

  tryAcquire(): (() => void) | null {
    if (this.active >= MAX_CONCURRENT_QUERIES) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

export interface LogQueryRouterOptions {
  logsRoot?: () => string;
  execute?: (logsRoot: string, query: LogQuery) => Promise<QueriedLogLine[]>;
}

export function buildLogQueryRouter(options: LogQueryRouterOptions = {}): Hono {
  const app = new Hono();
  const gate = new QueryGate();
  const logsRoot = options.logsRoot ?? sharedLogsRoot;
  const execute = options.execute ?? queryLogs;

  app.get('/api/v1/logs/query', async (c) => {
    const parsed = QueryParamsSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400);
    }
    const from = parseTimestamp(parsed.data.from);
    const to = parseTimestamp(parsed.data.to);
    if (from === null || to === null || from > to) {
      return c.json({ error: 'invalid_time_range' }, 400);
    }
    const release = gate.tryAcquire();
    if (!release) return c.json({ error: 'too_many_log_queries' }, 429);
    const query: LogQuery = {
      codes: parseCodes(parsed.data.codes),
      from,
      to,
      level: parsed.data.level,
      contains: parsed.data.contains,
      limit: parsed.data.limit,
    };
    try {
      return c.json({ logs: await execute(logsRoot(), query) });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'log query failed');
      return c.json({ error: 'log_query_failed' }, 500);
    } finally {
      release();
    }
  });

  return app;
}

function parseCodes(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const codes = [...new Set(raw.split(',').map((code) => code.trim()).filter(Boolean))];
  return codes.length > 0 ? codes : undefined;
}

function parseTimestamp(raw: string): number | null {
  const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}
