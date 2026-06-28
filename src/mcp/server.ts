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

/** backend に POST して JSON を返す。 4xx/5xx でも本文を返す (操作結果を見せるため)。 */
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-excubitor-actor': 'mcp' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new Error(`Excubitor backend (${BASE}) に接続できません: ${(err as Error).message}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { status: res.status, body: text } as T;
  }
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
  'excubitor_llm_logs',
  'LLM 使用ログを全サービス横断で取得する。通常ログとは別の llm channel に記録されたプロンプト・トークン数・コストを返す。codes で絞り込み可。',
  {
    codes: z.array(z.string()).optional().describe('絞り込むサービスコード配列 (省略で全サービス)'),
    limit: z.number().int().positive().max(5000).optional().describe('最大件数 (既定 500)'),
  },
  async ({ codes, limit }) => {
    try {
      const params = new URLSearchParams();
      if (codes && codes.length > 0) params.set('codes', codes.join(','));
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      return jsonContent(await apiGet(`/api/v1/logs/llm${qs ? `?${qs}` : ''}`));
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

server.tool(
  'excubitor_control_service',
  'サービスを start / stop / restart する (再起動含む)。 docker-compose / node / dev-process-md / app に対応。',
  {
    code: z.string().describe('サービスコード'),
    action: z.enum(['start', 'stop', 'restart']).describe('操作 (restart で再起動)'),
  },
  async ({ code, action }) => {
    try {
      return jsonContent(await apiPost(`/api/v1/services/${encodeURIComponent(code)}/control`, { action }));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_update_service',
  'サービスのリポを pull (更新) する。 git ff-only → 任意で npm install / build → 起動中なら restart。 dirty なリポは中断。',
  {
    code: z.string().describe('サービスコード'),
    install: z.boolean().optional().describe('package.json があれば npm install する (既定 true)'),
    restart: z.boolean().optional().describe('起動中なら適用後に restart する (既定 true)。 pull のみなら false'),
  },
  async ({ code, install, restart }) => {
    try {
      return jsonContent(await apiPost(`/api/v1/services/${encodeURIComponent(code)}/update`, { install, restart }));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_check_updates',
  '全サービスのアップデート状態 (ブランチ / behind / ahead / dirty)。 fetch=true で origin を取得 (遅い)。',
  { fetch: z.boolean().optional().describe('origin を fetch してから比較する') },
  async ({ fetch }) => {
    try {
      return jsonContent(await apiGet(`/api/v1/updates${fetch ? '?fetch=1' : ''}`));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_branch_status',
  '単一サービスのブランチ状況 (現在ブランチ / ローカル+リモート一覧 / ahead-behind / dirty)。',
  { code: z.string().describe('サービスコード') },
  async ({ code }) => {
    try {
      return jsonContent(await apiGet(`/api/v1/services/${encodeURIComponent(code)}/branches`));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_memory_summary',
  'メモリ + CPU 監視サマリ。 各サービス / WSL / マシン全体 (host) の RSS・CPU%・リーク判定。',
  {},
  async () => {
    try {
      return jsonContent(await apiGet('/api/v1/memory/summary'));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_federation_services',
  '他拠点 (リモート Excubitor ピア) を含む全ノードのサービス集約。 local + 各 enabled ピアのサマリ/サービス/host メトリクス。',
  {},
  async () => {
    try {
      return jsonContent(await apiGet('/api/v1/federation/services'));
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_remote_control',
  '他拠点ピアの 1 サービスを start / stop / restart する (federation プロキシ)。',
  {
    peer_id: z.string().describe('ピア ID (excubitor_list_peers で取得)'),
    code: z.string().describe('リモートのサービスコード'),
    action: z.enum(['start', 'stop', 'restart']),
  },
  async ({ peer_id, code, action }) => {
    try {
      return jsonContent(
        await apiPost(`/api/v1/peers/${encodeURIComponent(peer_id)}/services/${encodeURIComponent(code)}/control`, { action }),
      );
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.tool(
  'excubitor_list_peers',
  '登録済みの他拠点 Excubitor ピア一覧 (name / base_url / 疎通状態)。',
  {},
  async () => {
    try {
      return jsonContent(await apiGet('/api/v1/peers'));
    } catch (err) {
      return errorContent(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
