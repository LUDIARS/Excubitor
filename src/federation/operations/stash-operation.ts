import type { Catalog } from '../../catalog/loader.js';
import { repoDirOf } from '../../update/checker.js';
import { stashWorkingTree } from '../../update/stash.js';
import { failed, failedAt, recordSteps, succeeded, type ExecutionOutcome, type OperationContext } from './context.js';
import { selfRepoOf } from './self-operation.js';

/** @implements SPEC-FEDERATION-OPERATIONS */
export async function runStashOperation(
  ctx: OperationContext,
  catalog: Catalog,
  stash: typeof stashWorkingTree = stashWorkingTree,
): Promise<ExecutionOutcome> {
  const target = ctx.op.target;
  const service = target.kind === 'service' ? catalog.services.find(svc => svc.code === target.code) : null;
  const dir = target.kind === 'excubitor' ? selfRepoOf(catalog).dir : service ? repoDirOf(service) : null;
  if (!dir) return failed('stash: 対象サービスの git checkout がありません');
  const bad = recordSteps(ctx, await stash(dir, ctx.op.id));
  return bad ? failedAt(bad) : succeeded();
}
