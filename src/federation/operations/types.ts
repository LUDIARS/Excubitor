/**
 * 拠点への依頼 (operation) の契約。 依頼する側 (peer-routes / MCP / UI) と受ける側
 * (operation-routes / runner) で同じ定義を使う。
 *
 * 依頼の種類:
 * - update:  最新の取得だけ (fast-forward)。 build も再起動もしない
 * - restart: 再起動
 * - deploy:  取得 + 依存 install + build + 再起動 (起動中のときだけ)
 * - reflect: build + 走っている版とディスクの版がずれているときだけ再起動 (取得はしない)
 * - start / stop: サービスの起動 / 停止 (Excubitor 自身には使えない)
 */

import { z } from 'zod';

/** @implements SPEC-FEDERATION-OPERATIONS */

export const OperationActionSchema = z.enum(['update', 'restart', 'deploy', 'reflect', 'start', 'stop']);
export type OperationAction = z.infer<typeof OperationActionSchema>;

/** Excubitor 自身に対して受け付ける依頼 (自分を止めたら依頼を受けられなくなるので stop / start は無い)。 */
export const SELF_ACTIONS: ReadonlySet<OperationAction> = new Set(['update', 'restart', 'deploy', 'reflect']);

export const OperationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), code: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('excubitor') }),
]);
export type OperationTarget = z.infer<typeof OperationTargetSchema>;

export const OperationRequestSchema = z.object({
  target: OperationTargetSchema,
  action: OperationActionSchema,
});
export type OperationRequest = z.infer<typeof OperationRequestSchema>;

/**
 * - queued:     受け付けて順番待ち
 * - running:    実行中
 * - restarting: Excubitor 自身の再起動を supervisor に依頼済み (再起動後の起動処理で結果を確定する)
 * - succeeded / failed: 終了
 */
export const OperationStatusSchema = z.enum(['queued', 'running', 'restarting', 'succeeded', 'failed']);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationStepSchema = z.object({
  step: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type OperationStep = z.infer<typeof OperationStepSchema>;

/** 更新の取得元。 origin = git remote、 mesh = 依頼元拠点から git bundle を受け取る。 */
export const UpdateSourceSchema = z.enum(['origin', 'mesh']);
export type UpdateSource = z.infer<typeof UpdateSourceSchema>;

export const OperationSummarySchema = z.object({
  id: z.string(),
  requested_by: z.string(),
  target: OperationTargetSchema,
  action: OperationActionSchema,
  status: OperationStatusSchema,
  source: UpdateSourceSchema,
  error: z.string().nullable(),
  last_step: z.string().nullable(),
  created_at: z.number(),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
});
export type OperationSummary = z.infer<typeof OperationSummarySchema>;

export const OperationDetailSchema = OperationSummarySchema.extend({
  steps: z.array(OperationStepSchema),
});
export type OperationDetail = z.infer<typeof OperationDetailSchema>;

/** 受け付けられる組み合わせか (pure): Excubitor 自身には SELF_ACTIONS だけ。 */
export function isActionAllowed(target: OperationTarget, action: OperationAction): boolean {
  return target.kind === 'service' || SELF_ACTIONS.has(action);
}
