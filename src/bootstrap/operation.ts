import type { Service } from '../catalog/loader.js';
import { controlServiceViaLocalTool } from '../local-control/service-adapter.js';
import { failed, succeeded, type ExecutionOutcome, type OperationContext } from '../federation/operations/context.js';
import { serviceCheckout } from './checkout.js';
import { bootstrapService, requireStopped } from './catalog.js';
import { readBootstrapManifest } from './manifest.js';
import { runBootstrapHook } from './hook.js';
import { migrateData } from './data.js';
import { BootstrapOptionsSchema } from './options.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export async function runBootstrapOperation(ctx: OperationContext, existing?: Service): Promise<ExecutionOutcome> {
  let step = 'validate';
  try {
    if (ctx.op.target.kind !== 'service') throw new Error('Service target required');
    const code = ctx.op.target.code;
    const bootstrap = ctx.op.action === 'bootstrap';
    const options = bootstrap ? BootstrapOptionsSchema.parse(ctx.op.meta.bootstrap) : null;
    const repository = options?.repository ?? existing?.repo;
    if (!repository) throw new Error('Service repository is required');
    step = 'clone';
    const root = await serviceCheckout(repository, bootstrap);
    ctx.record({ step, ok: true, detail: repository + ' main checkout verified' });
    step = 'preflight';
    const manifest = await readBootstrapManifest(root, code);
    bootstrapService(code, root, repository);
    await requireStopped(code, ctx.actor);
    ctx.record({ step, ok: true, detail: 'Contract and stopped state verified' });
    if (!bootstrap) {
      const action = ctx.op.action;
      if (action !== 'data-export' && action !== 'data-import') throw new Error('Unsupported migration action');
      step = action;
      const detail = await migrateData(root, manifest, action, ctx.op.meta.data);
      ctx.record({ step, ok: true, detail });
      return succeeded();
    }
    step = 'setup';
    await runBootstrapHook(root, manifest.setup, []);
    ctx.record({ step, ok: true, detail: 'Service-owned setup completed' });
    if (options?.start) {
      step = 'start';
      // Reload after setup; setup cannot switch the catalog to another checkout.
      const refreshed = bootstrapService(code, root, repository);
      const result = await controlServiceViaLocalTool(refreshed, 'start', ctx.actor);
      if (!result.ok) throw new Error('Supervisor start failed; inspect service logs');
      ctx.record({ step, ok: true, detail: 'Supervisor start completed' });
    }
    return succeeded();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.record({ step, ok: false, detail });
    return failed(step + ': ' + detail);
  }
}
