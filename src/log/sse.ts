/**
 * ライブログ SSE (`GET /api/v1/services/:code/logs`)。
 *
 * log bus を購読し、 指定 service_code の行を Server-Sent Events で配信する。
 * frontend の subscribeLogs (EventSource) が購読する。 docker-tail / process-bridge /
 * Vestigium file-tail のいずれの経路で来た行もここに乗る。
 *
 * 注意: これはライブストリーム。 Excubitor 再起動中など接続が無い間の行は流れない
 * (= ストリーム欠落は許容)。 接続直前の行は /logs/recent のリングから取得する。
 */

import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { subscribe, type LogLine } from './bus.js';
import { recentLogLines } from './ring-buffer.js';
import { sharedLogsRoot } from './logs-root.js';
import { listVestigiumServices, recent } from './vestigium-reader.js';
import { acquireRedisLock, readRedisJson, redisCacheKey, writeRedisJson } from '../shared/redis-cache.js';

const RECENT_LOG_CACHE_MS = readPositiveIntEnv('EXCUBITOR_RECENT_LOG_CACHE_MS', 5_000);
const RECENT_LOG_REDIS_TTL_MS = cacheStorageTtl(RECENT_LOG_CACHE_MS);

interface LlmLogCache {
  logs: ReturnType<typeof recent>;
  capturedAt: number;
}

/** `?codes=a,b,c` を Set に。 空/未指定なら undefined (= 全サービス)。 */
function parseCodes(raw: string | undefined): Set<string> | undefined {
  if (!raw) return undefined;
  const codes = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return codes.length > 0 ? new Set(codes) : undefined;
}

/**
 * log bus を購読し、 filter (codes) に合う行を SSE で配信する共通ループ。
 * single (1 サービス) でも all (全サービス) でも同じロジックを使う。
 */
function streamFiltered(
  c: Context,
  filter: ((line: LogLine) => boolean) | undefined,
  openMeta: Record<string, unknown>,
): Response {
  return streamSSE(c, async (stream) => {
    const queue: LogLine[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = subscribe((line) => {
      if (filter && !filter(line)) return;
      queue.push(line);
      notify?.();
    });

    stream.onAbort(() => unsubscribe());

    try {
      await stream.writeSSE({ event: 'open', data: JSON.stringify(openMeta) });
      for (;;) {
        if (stream.aborted) break;
        if (queue.length === 0) {
          await Promise.race([
            new Promise<void>((r) => (notify = r)),
            stream.sleep(15000),
          ]);
          notify = null;
          if (queue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '1' });
            continue;
          }
        }
        const line = queue.shift()!;
        await stream.writeSSE({
          event: 'log',
          data: JSON.stringify({
            code: line.service_code,
            channel: line.channel,
            ts: line.ts instanceof Date ? line.ts.toISOString() : String(line.ts),
            line: line.line,
          }),
        });
      }
    } finally {
      unsubscribe();
    }
  });
}

export function buildLogStreamRouter(): Hono {
  const app = new Hono();
  const llmCache = new Map<string, {
    logs: ReturnType<typeof recent>;
    capturedAt: number;
    pending: boolean;
  }>();

  async function cachedLlmLogs(logsRoot: string, codes: Set<string> | undefined, limit: number): Promise<ReturnType<typeof recent>> {
    const key = `${codes ? [...codes].sort().join(',') : '*'}:${limit}`;
    const redisKey = redisCacheKey(`logs:llm:v1:${key}`);
    let entry = llmCache.get(key);
    if (entry && Date.now() - entry.capturedAt < RECENT_LOG_CACHE_MS) {
      return entry.logs.slice(0, limit);
    }
    const now = Date.now();
    const cached = await readRedisJson<LlmLogCache>(redisKey);
    if (cached) {
      const sourceStale = now - cached.capturedAt >= RECENT_LOG_CACHE_MS;
      entry = { logs: cached.logs, capturedAt: now, pending: entry?.pending ?? false };
      llmCache.set(key, entry);
      if (sourceStale) refreshLlmLogs(key, redisKey, logsRoot, codes, limit);
      return cached.logs.slice(0, limit);
    }
    if (!entry) {
      entry = { logs: [], capturedAt: 0, pending: false };
      llmCache.set(key, entry);
    }
    refreshLlmLogs(key, redisKey, logsRoot, codes, limit);
    return entry.logs.slice(0, limit);
  }

  function refreshLlmLogs(
    key: string,
    redisKey: string,
    logsRoot: string,
    codes: Set<string> | undefined,
    limit: number,
  ): void {
    const entry = llmCache.get(key);
    if (!entry || entry.pending) return;
    entry.pending = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const lock = await acquireRedisLock(`${redisKey}:refresh`, Math.max(RECENT_LOG_CACHE_MS, 1_000));
          if (lock === false) return;
          const logs = readLlmLogs(logsRoot, codes, limit);
          const next = { logs, capturedAt: Date.now() };
          entry.logs = next.logs;
          entry.capturedAt = next.capturedAt;
          if (lock === true) await writeRedisJson(redisKey, next, RECENT_LOG_REDIS_TTL_MS);
        } finally {
          entry.pending = false;
        }
      })();
    }, 0);
    timer.unref?.();
  }

  // 単一サービスのライブストリーム。
  app.get('/api/v1/services/:code/logs', (c) => {
    const code = c.req.param('code');
    return streamFiltered(c, (line) => line.service_code === code, { code });
  });

  // 全サービス横断ストリーム (req4)。 `?codes=a,b` で複数サービスに絞れる。
  app.get('/api/v1/logs', (c) => {
    const codes = parseCodes(c.req.query('codes'));
    return streamFiltered(c, codes ? (line) => codes.has(line.service_code) : undefined, {
      codes: codes ? [...codes] : 'all',
    });
  });

  // 全サービス横断の直近ログ。 DB を介さず共有リングから返す。
  app.get('/api/v1/logs/recent', (c) => {
    const codes = parseCodes(c.req.query('codes'));
    const limitRaw = Number(c.req.query('limit') ?? 300);
    const limit = Math.max(1, Math.min(5000, isFinite(limitRaw) ? limitRaw : 300));
    return c.json({ logs: recentLogLines({ codes, limit }) });
  });

  // LLM 使用ログ専用 — Vestigium 'llm' channel を全サービス横断で読む。
  // 通常ログ (bus/SSE) とは別経路 (Vestigium JSONL 直読み)。
  // ?codes=a,b で絞り込み、?limit= で最大件数 (既定 500)。
  app.get('/api/v1/logs/llm', async (c) => {
    const logsRoot = sharedLogsRoot();
    const codes = parseCodes(c.req.query('codes'));
    const limitRaw = Number(c.req.query('limit') ?? 500);
    const limit = Math.max(1, Math.min(5000, isFinite(limitRaw) ? limitRaw : 500));

    return c.json({ logs: await cachedLlmLogs(logsRoot, codes, limit) });
  });

  void cachedLlmLogs(sharedLogsRoot(), undefined, 500);
  return app;
}

function readLlmLogs(logsRoot: string, codes: Set<string> | undefined, limit: number): ReturnType<typeof recent> {
  const services = listVestigiumServices(logsRoot);
  const targets = codes ? services.filter((s) => codes.has(s)) : services;
  const all: ReturnType<typeof recent> = [];
  for (const svc of targets) {
    const records = recent({
      logPath: path.join(logsRoot, svc),
      channel: ['llm'],
      limit,
    });
    for (const r of records) all.push(r);
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function cacheStorageTtl(freshMs: number): number {
  return Math.max(freshMs * 12, 60_000);
}
