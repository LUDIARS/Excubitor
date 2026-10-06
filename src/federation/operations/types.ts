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
import { BootstrapOptionsSchema, DataOptionsSchema } from '../../bootstrap/options.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export const OperationActionSchema = z.enum(['update', 'restart', 'deploy', 'reflect', 'start', 'stop', 'bootstrap', 'data-export', 'data-import']);
export type OperationAction = z.infer<typeof OperationActionSchema>;

/** Excubitor 自身に対して受け付ける依頼 (自分を止めたら依頼を受けられなくなるので stop / start は無い)。 */
export const SELF_ACTIONS: ReadonlySet<OperationAction> = new Set(['update', 'restart', 'deploy', 'reflect']);

/** bootstrap 指定を添えられる依頼。 update / deploy は受ける拠点にサービスが無いときだけ bootstrap になる。 */
export const BOOTSTRAP_CAPABLE_ACTIONS: ReadonlySet<OperationAction> = new Set(['bootstrap', 'update', 'deploy']);

export const OperationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), code: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('excubitor') }),
]);
export type OperationTarget = z.infer<typeof OperationTargetSchema>;

export const OperationRequestSchema = z.object({
  target: OperationTargetSchema,
  action: OperationActionSchema,
  bootstrap: BootstrapOptionsSchema.optional(),
  data: DataOptionsSchema.optional(),
}).superRefine((value, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  // update / deploy にも bootstrap 指定を添えられる: 受ける拠点の catalog にそのサービスが無ければ bootstrap として扱う。
  if (value.action === 'bootstrap' && !value.bootstrap) issue('bootstrap options required for bootstrap');
  if (value.bootstrap && !BOOTSTRAP_CAPABLE_ACTIONS.has(value.action)) issue('bootstrap options are only for bootstrap / update / deploy');
  const migration = value.action === 'data-export' || value.action === 'data-import';
  if (migration !== Boolean(value.data)) issue('data options required only for data operations');
  if (value.action === 'data-import' && !value.data?.sha256) issue('import requires sha256');
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
