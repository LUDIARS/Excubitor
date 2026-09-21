/**
 * Excubitor MCP ツール定義 (transport 非依存)。
 *
 * 稼働中の Excubitor backend (HTTP) を叩く薄いクライアントに徹し、
 * DB / 業務ロジックは backend に委譲する (= API と二重実装しない)。
 * stdio 入口 (server.ts) と backend 直載せの Streamable HTTP 入口 (http.ts) が共用する。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** ツール結果を text content にまとめる。 */
function jsonContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorContent(err: unknown) {
  return { content: [{ type: 'text' as const, text: `error: ${(err as Error).message}` }], isError: true };
}

/** baseUrl の backend に紐づく McpServer を組み立てる。 */
export function buildMcpServer(baseUrl: string): McpServer {
  /** backend に GET して JSON を返す。 失敗は説明的な Error。 */
  async function apiGet<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`);
    } catch (err) {
      throw new Error(`Excubitor backend (${baseUrl}) に接続できません: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  /** backend に POST して JSON を返す。 4xx/5xx でも本文を返す (操作結果を見せるため)。 */
  async function apiPost<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-excubitor-actor': 'mcp' },
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      throw new Error(`Excubitor backend (${baseUrl}) に接続できません: ${(err as Error).message}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return { status: res.status, body: text } as T;
    }
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
    'インメモリリングの直近ログを取得する。 code 指定で 1 サービス、 省略で全サービス横断。 codes で複数指定可。',
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
    'excubitor_query_logs',
    'Vestigium JSONL / Parquet の履歴ログを期間指定で検索する。',
    {
      codes: z.array(z.string()).optional().describe('絞り込むサービスコード配列 (省略で全サービス)'),
      from: z.string().describe('開始時刻 (UTC ISO 8601 または epoch milliseconds)'),
      to: z.string().describe('終了時刻 (UTC ISO 8601 または epoch milliseconds)'),
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
      contains: z.string().max(1000).optional().describe('メッセージの部分一致'),
      limit: z.number().int().positive().max(5000).optional().describe('最大件数 (既定 300)'),
    },
    async ({ codes, from, to, level, contains, limit }) => {
      try {
        const params = new URLSearchParams({ from, to });
        if (codes && codes.length > 0) params.set('codes', codes.join(','));
        if (level) params.set('level', level);
        if (contains) params.set('contains', contains);
        if (limit) params.set('limit', String(limit));
        return jsonContent(await apiGet(`/api/v1/logs/query?${params.toString()}`));
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
    '他拠点 (リモート Excubitor ピア) を含む全ノードのサービス集約。 local + 各 enabled ピアのサマリ/サービス/host メトリクス (ピア分は巡回キャッシュ)。',
    {},
    async () => {
      try {
        return jsonContent(await apiGet('/api/v1/federation/services'));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  /** @implements SPEC-FEDERATION-COVERAGE */
  server.tool(
    'excubitor_federation_mesh',
    '拠点メッシュの集約。 拠点ごとの到達性、 拠点→拠点のつながり (双方向別々)、 サービスごとにどの拠点が担保しているか (duplicate_managed / uncovered / down の指摘付き)。 値は各拠点がキャッシュした死活で、 呼んでも probe は走らない。',
    {},
    async () => {
      try {
        return jsonContent(await apiGet('/api/v1/federation/mesh'));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  /** @implements SPEC-FEDERATION-OPERATIONS */
  server.tool(
    'excubitor_request_operation',
    '拠点の Excubitor に依頼する: update (最新の取得だけ) / restart / deploy (取得+install+build+再起動) / reflect (build+版ズレ時だけ再起動) / start / stop。 target は サービスコード か "excubitor" (その拠点の Excubitor 自身。 start/stop 不可)。 peer_id を省くと自拠点への依頼。 依頼は非同期で、 返る operation.id を excubitor_operation_status で追う。 他拠点への依頼は相互登録済みのピアにだけ届く。',
    {
      peer_id: z.string().optional().describe('ピア ID (excubitor_list_peers で取得)。 省略時は自拠点'),
      target: z.string().describe('サービスコード、 または "excubitor"'),
      action: z.enum(['update', 'restart', 'deploy', 'reflect', 'start', 'stop']),
    },
    async ({ peer_id, target, action }) => {
      try {
        const body = { target: target === 'excubitor' ? { kind: 'excubitor' } : { kind: 'service', code: target }, action };
        const path = peer_id ? `/api/v1/peers/${encodeURIComponent(peer_id)}/operations` : '/api/v1/operations';
        return jsonContent(await apiPost(path, body));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.tool(
    'excubitor_operation_status',
    '依頼の状態 (queued / running / restarting / succeeded / failed) と実行した手順。 peer_id を省くと自拠点の依頼。',
    {
      operation_id: z.string().describe('excubitor_request_operation が返した operation.id'),
      peer_id: z.string().optional().describe('依頼先のピア ID。 省略時は自拠点'),
    },
    async ({ operation_id, peer_id }) => {
      try {
        const id = encodeURIComponent(operation_id);
        const path = peer_id ? `/api/v1/peers/${encodeURIComponent(peer_id)}/operations/${id}` : `/api/v1/operations/${id}`;
        return jsonContent(await apiGet(path));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.tool(
    'excubitor_cf_tunnel_routes',
    'Cloudflare Tunnel の public hostname ルートを list / add / remove する (CF トークンは Excubitor が保持)。変更は allowlist 掲載 hostname のみ。',
    {
      action: z.enum(['list', 'add', 'remove']).describe('操作'),
      tunnel: z.string().optional().describe('tunnel の id か name (アカウントに 1 本だけなら省略可)'),
      hostname: z.string().optional().describe('add / remove 対象の hostname (add/remove で必須)'),
      service: z.string().optional().describe('add の転送先 (例 http://127.0.0.1:17400)'),
      path: z.string().optional().describe('パス条件 (CF ingress の path 正規表現)'),
    },
    async ({ action, tunnel, hostname, service, path }) => {
      try {
        if (action === 'list') {
          const q = tunnel ? `?tunnel=${encodeURIComponent(tunnel)}` : '';
          return jsonContent(await apiGet(`/api/v1/cf-tunnel/routes${q}`));
        }
        if (!hostname) {
          return errorContent(new Error(`action=${action} には hostname が必須`));
        }
        if (action === 'add') {
          if (!service) {
            return errorContent(new Error('action=add には service が必須'));
          }
          return jsonContent(await apiPost('/api/v1/cf-tunnel/routes', { tunnel, hostname, service, path }));
        }
        return jsonContent(await apiPost('/api/v1/cf-tunnel/routes/remove', { tunnel, hostname, path }));
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

  return server;
}
