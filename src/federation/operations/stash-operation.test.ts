import { describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../catalog/loader.js';
import type { StepResult } from '../../update/steps.js';
import type { OperationContext } from './context.js';
import type { OperationRecord } from './store.js';
import type { OperationTarget } from './types.js';
import { runStashOperation } from './stash-operation.js';
import { validateOperationRequest } from './validate.js';

const catalog = { services: [{ code: 'svc', cwd: 'C:/Ars/Service' }, { code: 'excubitor', cwd: 'C:/Ars/Excubitor' }] } as Catalog;
function context(target: OperationTarget): OperationContext & { steps: StepResult[] } {
  const steps: StepResult[] = [];
  return { op: { id: 'op-stash', action: 'stash', target } as OperationRecord, actor: 'local', requester: null, record: step => steps.push(step), steps };
}
describe('stash operation routing', () => {
  it.each([
    [{ kind: 'excubitor' }, 'C:/Ars/Excubitor'],
    [{ kind: 'service', code: 'svc' }, 'C:/Ars/Service'],
  ] as const)('stashes the catalog-owned checkout for %j and records the receipt', async (target, dir) => {
    const stash = vi.fn(async () => [{ step: 'stash', ok: true, detail: 'stash commit abc' }]);
    const ctx = context(target);
    expect(validateOperationRequest({ target, action: 'stash' }, catalog, new Map(), 'origin')).toMatchObject({ ok: true });
    await expect(runStashOperation(ctx, catalog, stash)).resolves.toMatchObject({ ok: true });
    expect(stash).toHaveBeenCalledWith(dir, 'op-stash');
    expect(ctx.steps).toEqual([{ step: 'stash', ok: true, detail: 'stash commit abc' }]);
  });

  it('preserves the receipt when post-stash verification fails', async () => {
    const stash = vi.fn(async () => [{ step: 'stash', ok: true, detail: 'stash commit abc' }, { step: 'stash_verify', ok: false, detail: 'remaining changes' }]);
    const ctx = context({ kind: 'excubitor' });
    await expect(runStashOperation(ctx, catalog, stash)).resolves.toMatchObject({ ok: false, error: 'stash_verify: remaining changes' });
    expect(ctx.steps).toHaveLength(2);
  });

  it('does not stash missing or uncovered services or accept bootstrap options', () => {
    expect(validateOperationRequest({ target: { kind: 'service', code: 'missing' }, action: 'stash' }, catalog, new Map(), 'origin')).toMatchObject({ ok: false, status: 404 });
    expect(validateOperationRequest({ target: { kind: 'service', code: 'svc' }, action: 'stash' }, catalog, new Map([['svc', false]]), 'origin')).toMatchObject({ ok: false, status: 409 });
    expect(validateOperationRequest({ target: { kind: 'excubitor' }, action: 'stash', bootstrap: { repository: 'LUDIARS/Excubitor' } }, catalog, new Map(), 'origin')).toMatchObject({ ok: false, status: 400 });
  });
});
