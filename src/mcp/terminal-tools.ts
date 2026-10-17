import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** @implements SPEC-TERMINAL-CONNECTIONS */
export function registerTerminalTools(server: McpServer, baseUrl: string): void {
  const call = async (path: string, body?: unknown) => {
    try {
      const response = await fetch(`${baseUrl}/api/v1/terminal${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-excubitor-terminal': '1' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(130_000),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(await response.json()) }], ...(!response.ok ? { isError: true } : {}) };
    } catch { return { content: [{ type: 'text' as const, text: 'Terminal request failed; remote completion is unknown. Do not retry automatically.' }], isError: true }; }
  };
  server.tool('excubitor_terminal_connections', '登録済みSSH接続先を一覧表示。認証情報の値は返さない。', {}, () => call('/profiles'));
  server.tool('excubitor_terminal_exec',
    '登録済み接続先で非対話コマンドを1回実行。ユーザーが許可した作業だけに使用。各実行は独立したshell。LAN/VPN以外はSSH鍵必須。失敗・時間切れ時は結果不明として自動再送しない。サービスの起動停止は従来のEx操作を使う。',
    { id: z.string().uuid(), command: z.string().min(1).max(16384), timeoutMs: z.number().int().min(1000).max(120000).default(30000) },
    ({ id, command, timeoutMs }) => call(`/profiles/${id}/exec`, { command, timeoutMs }));
}
