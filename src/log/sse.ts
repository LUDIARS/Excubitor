/**
 * ライブログ SSE (`GET /api/v1/services/:code/logs`)。
 *
 * log bus を購読し、 指定 service_code の行を Server-Sent Events で配信する。
 * frontend の subscribeLogs (EventSource) が購読する。 docker-tail / process-bridge /
 * Vestigium file-tail のいずれの経路で来た行もここに乗る。
 *
 * 注意: これはライブストリーム。 Excubitor 再起動中など接続が無い間の行は流れない
 * (= ストリーム欠落は許容)。 永続化された過去ログは /logs/recent で取得する。
 */

import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscribe, type LogLine } from './bus.js';
import { sharedLogsRoot } from './logs-root.js';
import { listVestigiumServices, recent } from './vestigium-reader.js';

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

  // 単一サービスのライブストリーム。
  app.get('/api/v1/services/:code/logs', (c) => {
    const code = c.req.param('code');
    return streamFiltered(c, (line) => line.service_code === code, { code });
  });

  // 全サービス横断ストリーム (req4)。 `?codes=a,b` で複数サービスに絞れる。
  // オンメモリには貯めず、 来た行をそのまま流す (永続化された過去は /logs/recent)。
  app.get('/api/v1/logs', (c) => {
    const codes = parseCodes(c.req.query('codes'));
    return streamFiltered(c, codes ? (line) => codes.has(line.service_code) : undefined, {
      codes: codes ? [...codes] : 'all',
    });
  });

  // 全サービス横断の直近ログ (永続化済み)。 `?codes=` で絞り、 `?level=` で最低レベル絞り込み。
  app.get('/api/v1/logs/recent', (c) => {
    const codes = parseCodes(c.req.query('codes'));
    const limitRaw = Number(c.req.query('limit') ?? 300);
    const limit = Math.max(1, Math.min(5000, isFinite(limitRaw) ? limitRaw : 300));
    const base = sql`
      SELECT s.code AS code, sil.id, sil.ts, sil.level, sil.line
      FROM service_instance_logs sil
      JOIN service_instances si ON si.id = sil.service_instance_id
      JOIN services s ON s.id = si.service_id
    `;
    const rows = codes
      ? db().all(sql`${base}
          WHERE s.code IN (${sql.join([...codes].map((x) => sql`${x}`), sql`, `)})
          ORDER BY sil.ts DESC LIMIT ${limit}`)
      : db().all(sql`${base} ORDER BY sil.ts DESC LIMIT ${limit}`);
    return c.json({ logs: rows });
  });

  // LLM 使用ログ専用 — Vestigium 'llm' channel を全サービス横断で読む。
  // 通常ログ (bus/SSE) とは別経路 (Vestigium JSONL 直読み)。
  // ?codes=a,b で絞り込み、?limit= で最大件数 (既定 500)。
  app.get('/api/v1/logs/llm', (c) => {
    const logsRoot = sharedLogsRoot();
    const codes = parseCodes(c.req.query('codes'));
    const limitRaw = Number(c.req.query('limit') ?? 500);
    const limit = Math.max(1, Math.min(5000, isFinite(limitRaw) ? limitRaw : 500));

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
    return c.json({ logs: all.slice(0, limit) });
  });

  return app;
}
