import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** @implements SPEC-EX-AWS-SITE */
/** Site placement uses the existing local coverage API, never AWS-specific control. */
export function registerSiteTools(server: McpServer, baseUrl: string): void {
  server.tool(
    'excubitor_site_coverage',
    'このツールが接続する拠点の担当サービスと死活を取得、または担当設定を変更する。AWSも通常の拠点として扱う。setはこの拠点だけに適用し、起動停止やデプロイは行わない。遠隔拠点の設定にはその拠点のExへ接続する。',
    {
      action: z.enum(['list', 'set']),
      code: z.string().min(1).optional().describe('set時のサービスコード'),
      covered: z.boolean().nullable().optional().describe('set時にtrue=担当、false=担当外、null=catalog既定'),
    },
    async ({ action, code, covered }) => {
      try {
        if (action === 'set' && (!code || covered === undefined)) {
          throw new Error('set requires code and covered (true / false / null)');
        }
        const path = action === 'list' ? '/api/v1/federation/coverage'
          : `/api/v1/federation/coverage/${encodeURIComponent(code!)}`;
        const response = await fetch(`${baseUrl}${path}`, {
          method: action === 'list' ? 'GET' : 'PUT',
          headers: { 'content-type': 'application/json', 'x-excubitor-actor': 'mcp' },
          ...(action === 'set' ? { body: JSON.stringify({ covered }) } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        const data: unknown = await response.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: response.status, data }, null, 2) }],
          ...(!response.ok ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Site coverage failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
}
