/**
 * Excubitor 自身への依頼を実行する。
 *
 * - update:  自分の checkout へ最新を取り込むだけ (走っている版は変わらない)
 * - deploy:  取り込み → 依存 install (本体 + frontend) → build (本体 + frontend) → 自己再起動
 * - reflect: ディスクの HEAD が起動時の版と違うときだけ build → 自己再起動
 * - restart: 自己再起動
 *
 * 自己再起動は supervisor に依頼する (design.md §16.4)。 受理されると backend はまもなく止まるので、
 * 依頼は restarting にして期待する git hash を残し、 新しい backend の起動処理 (runner.recover) で
 * 実際に起動した版と照合して結果を確定する。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Catalog } from '../../catalog/loader.js';
import { restartExcubitorViaLocalTool } from '../../local-control/service-adapter.js';
import { readGitDirty } from '../../scanner/git.js';
import { hasBuildScript, installDependencies, runNpmBuild, type StepResult } from '../../update/steps.js';
import { getSelfVersion, readCurrentHead } from '../self-version.js';
import { failed, failedAt, recordSteps, succeeded, type ExecutionOutcome, type OperationContext } from './context.js';
import { fetchLatest, type FetchLatest } from './fetch-latest.js';
import { markRestarting } from './store.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export const SELF_SERVICE_CODE = 'excubitor';
const FRONTEND_DIR = 'frontend';

export interface SelfRepo {
  dir: string;
  repo: string | null;
}

/** 自分の checkout: catalog の excubitor エントリの cwd (無ければプロセスの cwd)。 */
export function selfRepoOf(catalog: Pick<Catalog, 'services'>, cwd = process.cwd()): SelfRepo {
  const entry = catalog.services.find((svc) => svc.code === SELF_SERVICE_CODE);
  return { dir: entry?.cwd ?? cwd, repo: entry?.repo ?? null };
}

export interface SelfOperationDeps {
  fetch?: FetchLatest;
  install?: typeof installDependencies;
  npmBuild?: (dir: string, prefix?: string) => Promise<StepResult>;
  readHead?: (dir: string) => Promise<{ branch: string | null; hash: string | null }>;
  isDirty?: (dir: string) => Promise<boolean | null>;
  bootHash?: () => string | null;
  requestRestart?: (actor: string) => Promise<{ ok: boolean; error: string | null }>;
  markRestarting?: (id: string, meta: Record<string, unknown>) => void;
  hasFrontend?: (dir: string) => boolean;
}

export async function runSelfOperation(
  self: SelfRepo,
  ctx: OperationContext,
  deps: SelfOperationDeps = {},
): Promise<ExecutionOutcome> {
  const readHead = deps.readHead ?? readCurrentHead;
  const action = ctx.op.action;

  if (action === 'restart') return selfRestart(self, ctx, deps);

  if (action === 'reflect') {
    const head = await readHead(self.dir);
    const boot = (deps.bootHash ?? (() => getSelfVersion()?.hash ?? null))();
    if (head.hash && boot && head.hash === boot) {
      ctx.record({ step: 'reflect', ok: true, detail: `走っている版 (${boot}) がディスクと同じため何もしない` });
      return succeeded();
    }
    const bad = await buildSelf(self, ctx, deps);
    return bad ? failedAt(bad) : selfRestart(self, ctx, deps);
  }

  if (action !== 'update' && action !== 'deploy') return failed(`action ${action} は Excubitor 自身には使えません`);

  const dirty = await (deps.isDirty ?? readGitDirty)(self.dir);
  if (dirty !== false) {
    return failedAt(recordSteps(ctx, [{
      step: 'dirty_check',
      ok: false,
      detail: dirty === null ? 'git の状態を確認できません' : '未コミット変更があるため中断 (手動で commit/stash してください)',
    }])!);
  }
  const head = await readHead(self.dir);
  if (!head.branch || head.branch === 'HEAD') return failedAt(recordSteps(ctx, [{ step: 'branch', ok: false, detail: 'ブランチを特定できません' }])!);

  const pulled = await (deps.fetch ?? fetchLatest)({
    source: ctx.op.source,
    repoDir: self.dir,
    branch: head.branch,
    repo: self.repo,
    requester: ctx.requester,
  });
  const badPull = recordSteps(ctx, pulled);
  if (badPull) return failedAt(badPull);
  if (action === 'update') return succeeded();

  const install = deps.install ?? installDependencies;
  const hasFrontend = (deps.hasFrontend ?? frontendExists)(self.dir);
  const preferOffline = ctx.op.source === 'mesh';
  const badInstall = recordSteps(ctx, [
    await install(self.dir, { preferOffline }),
    hasFrontend ? await install(self.dir, { preferOffline, prefix: FRONTEND_DIR }) : null,
  ]);
  if (badInstall) return failedAt(badInstall);
  const badBuild = await buildSelf(self, ctx, deps);
  return badBuild ? failedAt(badBuild) : selfRestart(self, ctx, deps);
}

function frontendExists(dir: string): boolean {
  return existsSync(join(dir, FRONTEND_DIR, 'package.json')) && hasBuildScript(join(dir, FRONTEND_DIR));
}

async function buildSelf(self: SelfRepo, ctx: OperationContext, deps: SelfOperationDeps): Promise<StepResult | null> {
  const npmBuild = deps.npmBuild ?? runNpmBuild;
  const hasFrontend = (deps.hasFrontend ?? frontendExists)(self.dir);
  const backend = recordSteps(ctx, [await npmBuild(self.dir)]);
  if (backend) return backend;
  return hasFrontend ? recordSteps(ctx, [await npmBuild(self.dir, FRONTEND_DIR)]) : null;
}

async function selfRestart(self: SelfRepo, ctx: OperationContext, deps: SelfOperationDeps): Promise<ExecutionOutcome> {
  const head = await (deps.readHead ?? readCurrentHead)(self.dir);
  (deps.markRestarting ?? markRestarting)(ctx.op.id, { expected_hash: head.hash });
  const accepted = await (deps.requestRestart ?? restartExcubitorViaLocalTool)(ctx.actor);
  ctx.record({
    step: 'restart_requested',
    ok: accepted.ok,
    detail: accepted.ok ? `supervisor が再起動を受理 (期待する版 ${head.hash ?? 'unknown'})` : (accepted.error ?? 'restart rejected'),
  });
  return accepted.ok ? { kind: 'restarting' } : failed(`restart_requested: ${accepted.error ?? 'restart rejected'}`);
}
