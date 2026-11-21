import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeId, jobId } from '../aws-compute/target-schema.js';

export function registerAwsComputeTools(server: McpServer, baseUrl: string): void {
  async function request(path: string, body?: unknown) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/aws-compute/jobs${path}`, {
        ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const result: unknown = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(!response.ok && { isError: true }) };
    } catch {
      return { content: [{ type: 'text' as const, text: 'AWS 計算ジョブ API に接続できません' }], isError: true };
    }
  }

  const operation = { operation_id: z.string().uuid() };
  server.tool('excubitor_aws_compute_submit', '登録済み AWS 実行先とランナーにジョブを投入する。入力は秘密を含まない参照や値に限る。', {
    target_id: computeId,
    job_id: jobId,
    runner: computeId,
    inputs: z.record(z.string()).optional(),
    deadline: z.string().datetime({ offset: true }),
  }, (args) => request('', args));
  server.tool('excubitor_aws_compute_status', 'AWS 計算ジョブの観測結果と解放状態を取得する。', operation,
    ({ operation_id }) => request(`/${operation_id}`));
  server.tool('excubitor_aws_compute_cancel', 'AWS 計算ジョブの停止を要求する。解放は後続の状態取得で確認する。', operation,
    ({ operation_id }) => request(`/${operation_id}/cancel`, {}));
  server.tool('excubitor_aws_compute_list', 'AWS 計算ジョブの履歴を取得する。', {
    active: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  }, ({ active = false, limit = 50, offset = 0 }) => request(`?active=${active}&limit=${limit}&offset=${offset}`));
}
