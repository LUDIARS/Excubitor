import type { Service } from '../../catalog/loader.js';
import { requestLocalControl } from '../../local-control/client.js';
import { controlServiceViaLocalTool } from '../../local-control/service-adapter.js';
import type { StepResult } from '../../update/steps.js';

/** @implements SPEC-EX-UNIFIED-UPDATE */
export async function refreshSelfViewer(service: Service, actor: string): Promise<StepResult> {
  const status = await requestLocalControl({ target: { kind: 'service', code: service.code }, action: 'status', actor }, { timeoutMs: 5_000 });
  if (!status.ok || status.payload?.kind !== 'service-status' || status.payload.running === null) {
    return { step: 'viewer', ok: false, detail: 'ExView の起動状態を確認できません' };
  }
  if (!status.payload.running) return { step: 'viewer', ok: true, detail: 'ExView は停止中のため起動しません' };
  const result = await controlServiceViaLocalTool(service, 'restart', actor);
  return { step: 'viewer', ok: result.ok, detail: result.ok ? '稼働中の ExView を更新しました' : 'ExView の再起動に失敗しました。サービスログを確認してください' };
}
