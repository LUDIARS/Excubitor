/**
 * Excubitor MCP サーバ (stdio 入口)。
 *
 * 通常は backend 直載せの Streamable HTTP (`/mcp`, src/mcp/http.ts) を使う。
 * stdio はセッション毎に node プロセスが立つ (≈50–100MB × セッション数) ため、
 * backend が動かせない環境や単発デバッグ用のフォールバックとして残す。
 * 起動: `npm run mcp`。 ツール定義は tools.ts (transport 非依存) を共用。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './tools.js';

const BASE = `http://127.0.0.1:${process.env.EXCUBITOR_PORT ?? 17332}`;

const server = buildMcpServer(BASE);
const transport = new StdioServerTransport();
await server.connect(transport);
