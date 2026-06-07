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

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { subscribe, type LogLine } from './bus.js';

export function buildLogStreamRouter(): Hono {
  const app = new Hono();

  app.get('/api/v1/services/:code/logs', (c) => {
    const code = c.req.param('code');
    return streamSSE(c, async (stream) => {
      const queue: LogLine[] = [];
      let notify: (() => void) | null = null;
      const unsubscribe = subscribe((line) => {
        if (line.service_code !== code) return;
        queue.push(line);
        notify?.();
      });

      stream.onAbort(() => unsubscribe());

      try {
        // 接続確立通知。
        await stream.writeSSE({ event: 'open', data: JSON.stringify({ code }) });
        for (;;) {
          if (stream.aborted) break;
          if (queue.length === 0) {
            // 行が来るまで待機 (最大 15s で keepalive)。
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
  });

  return app;
}
