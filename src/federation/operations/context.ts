/**
 * 依頼 1 件を実行するときの共通の入れ物と、 手順の積み上げ方。
 */

import type { StepResult } from '../../update/steps.js';
import type { RemotePeer } from '../store.js';
import type { OperationRecord } from './store.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export interface OperationContext {
  op: OperationRecord;
  /** 監査ログ / supervisor へ渡す実行者 (例 `federation:<拠点名>` / `local`)。 */
  actor: string;
  /** 依頼元ピア (自拠点からの依頼なら null)。 mesh 取得元はここから bundle を受け取る。 */
  requester: RemotePeer | null;
  /** 手順を 1 つ記録する (DB に積み、 依頼元から見えるようにする)。 */
  record: (step: StepResult) => void;
}

/**
 * - finished:   終わった (成否つき)
 * - restarting: Excubitor 自身の再起動を supervisor が受理した。 結果は再起動後の起動処理で確定する
 */
export type ExecutionOutcome =
  | { kind: 'finished'; ok: boolean; error: string | null }
  | { kind: 'restarting' };

export function succeeded(): ExecutionOutcome {
  return { kind: 'finished', ok: true, error: null };
}

export function failed(error: string): ExecutionOutcome {
  return { kind: 'finished', ok: false, error };
}

/** 手順を順に記録し、 最初の失敗を返す (無ければ null)。 */
export function recordSteps(ctx: OperationContext, steps: ReadonlyArray<StepResult | null>): StepResult | null {
  for (const step of steps) {
    if (!step) continue;
    ctx.record(step);
    if (!step.ok) return step;
  }
  return null;
}

export function failedAt(step: StepResult): ExecutionOutcome {
  return failed(`${step.step}: ${step.detail || 'failed'}`);
}
