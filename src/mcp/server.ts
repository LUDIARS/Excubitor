/**
 * Excubitor MCP サーバ (stdio)。
 *
 * 「ログの取得は API、 MCP で対応できるようにする」 (req4) の MCP 面。
 * 稼働中の Excubitor backend (HTTP :EXCUBITOR_PORT) を叩く薄いクライアントに徹し、
 * DB / 業務ロジックは backend に委譲する (= API と二重実装しない)。
 *
 * 起動: `npm run mcp` (tsx src/mcp/server.ts)。 Claude Code / 他 MCP クライアントから
 *   stdio で接続する。 backend が落ちているとツールはエラーを返す。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = `http://127.0.0.1:${process.env.EXCUBITOR_PORT ?? 17332}`;

/** backend に GET して JSON を返す。 失敗は説明的な Error。 */
async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`);
  } catch (err) {
    throw new Error(`Excubitor backend (${BASE}) に接続できません: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** ツール結果を text content にまとめる。 */
function jsonContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorContent(err: unknown) {
  return { content: [{ type: 'text' as const, text: `error: ${(err as Error).message}` }], isError: true };
}

const server = new McpServer({ name: 'excubitor', version: '0.2.0' });

server.tool(
  'excubitor_list_services',
  'LUDIARS 全サービスの一覧と死活 state (running/stopped/crashed/unknown)、 port、 git を返す。',
  {},
  async () => {
    try {
      return jsonContent(await apiGet('/api/v1/services'));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_service_detail',
  '単一サービスの詳細 (state / git / version / port / instance)。',
  { code: z.string().describe('サービスコード (例: concordia, memoria-server)') },
  async ({ code }) => {
    try {
      return jsonContent(await apiGet(`/api/v1/services/${encodeURIComponent(code)}`));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_recent_logs',
  '永続化された直近ログを取得する。 code 指定で 1 サービス、 省略で全サービス横断。 codes で複数指定可。',
  {
    code: z.string().optional().describe('単一サービスに絞る場合のコード'),
    codes: z.array(z.string()).optional().describe('複数サービスに絞る場合のコード配列 (横断)'),
    limit: z.number().int().positive().max(5000).optional().describe('最大行数 (既定 300)'),
  },
  async ({ code, codes, limit }) => {
    try {
      const q = limit ? `?limit=${limit}` : '';
      if (code) {
        return jsonContent(await apiGet(`/api/v1/services/${encodeURIComponent(code)}/logs/recent${q}`));
      }
      const params = new URLSearchParams();
      if (codes && codes.length > 0) params.set('codes', codes.join(','));
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      return jsonContent(await apiGet(`/api/v1/logs/recent${qs ? `?${qs}` : ''}`));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_ports',
  'ポート占有・衝突レポート (catalog 宣言 port の重複、 LISTEN 占有、 foreign 衝突)。',
  {},
  async () => {
    try {
      return jsonContent(await apiGet('/api/v1/ports'));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_error_tasks',
  'エラー triage キュー (検知済みエラー)。 state で絞り込み (open/ack/resolved/dismissed/snoozed)。',
  { state: z.string().optional().describe('絞り込む state') },
  async ({ state }) => {
    try {
      const q = state ? `?state=${encodeURIComponent(state)}` : '';
      return jsonContent(await apiGet(`/api/v1/error-tasks${q}`));
    } catch (err) {
      return errorContent(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
