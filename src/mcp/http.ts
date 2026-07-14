/**
 * MCP Streamable HTTP 入口 (backend 直載せ、 `POST /mcp`)。
 *
 * 従来はセッション毎に stdio の MCP プロセスが立ち、 tsx ラッパ + 本体で
 * ≈100MB × セッション数 (実測 16 プロセス / 950MB) を常食していた。
 * backend の Hono に直載せすることでセッション毎プロセスを不要にする。
 *
 * stateless 運用: リクエスト毎に server + transport を作り捨てる
 * (SDK 推奨形。 ツールは backend API への薄いプロキシで状態を持たない)。
 * GET/DELETE (SSE 常駐ストリーム / セッション終了) は stateless では不要なので 405。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createNamedLogger } from '../shared/logger.js';
import { buildMcpServer } from './tools.js';

const logger = createNamedLogger('excubitor.mcp-http');

type NodeBindings = { incoming: IncomingMessage; outgoing: ServerResponse };

export function buildMcpHttpRouter(baseUrl: string): Hono {
  const app = new Hono();

  app.post('/mcp', async (c) => {
    const { incoming, outgoing } = c.env as unknown as NodeBindings;
    const server = buildMcpServer(baseUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    outgoing.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      const body = await c.req.json().catch(() => undefined);
      await transport.handleRequest(incoming, outgoing, body);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'mcp http request failed');
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal server error' },
            id: null,
          }),
        );
      }
    }
    // handleRequest が Node の res に直接書くので Hono には応答済みを伝える。
    return RESPONSE_ALREADY_SENT;
  });

  const methodNotAllowed = (c: { json: (o: unknown, s: 405) => Response }) =>
    c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless MCP: POST のみ)' },
        id: null,
      },
      405,
    );
  app.get('/mcp', (c) => methodNotAllowed(c));
  app.delete('/mcp', (c) => methodNotAllowed(c));

  return app;
}
