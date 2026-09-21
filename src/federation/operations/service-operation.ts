/**
 * サービスへの依頼を実行する。
 *
 * - start / stop / restart: supervisor へ操作を依頼
 * - update:  取り込みだけ (repo が綺麗なときだけ)
 * - deploy:  取り込み → 依存 install → build → 起動中なら再起動
 * - reflect: build → 起動中で、 走っている版とディスクの版が一致しないときだけ再起動
 *            (版を名乗らないサービスは一致を確かめられないので再起動する)
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Service } from '../../catalog/loader.js';
import { controlServiceViaLocalTool } from '../../local-control/service-adapter.js';
import { isManaged } from '../../process/manager.js';
import { resolveServiceRuntimeVersion } from '../../process/service-version.js';
import { reconcileStatus, type VersionReconcileStatus } from '../../scanner/version-reconcile.js';
import { repoDirOf } from '../../update/checker.js';
import { currentState } from '../../update/service-state.js';
import {
  buildService,
  checkRepoReady,
  installDependencies,
  tail,
  type StepResult,
} from '../../update/steps.js';
import { failed, failedAt, recordSteps, succeeded, type ExecutionOutcome, type OperationContext } from './context.js';
import { fetchLatest, type FetchLatest } from './fetch-latest.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export interface ServiceOperationDeps {
  control?: (svc: Service, action: 'start' | 'stop' | 'restart', actor: string) => Promise<StepResult>;
  checkRepo?: typeof checkRepoReady;
  fetch?: FetchLatest;
  install?: typeof installDependencies;
  build?: typeof buildService;
  isRunning?: (svc: Service) => boolean;
  versionStatus?: (svc: Service) => Promise<VersionReconcileStatus>;
}

async function controlStep(svc: Service, action: 'start' | 'stop' | 'restart', actor: string): Promise<StepResult> {
  const r = await controlServiceViaLocalTool(svc, action, actor);
  return { step: action, ok: r.ok, detail: tail(r.ok ? r.stdout : (r.stderr || r.stdout)) };
}

function serviceIsRunning(svc: Service): boolean {
  return isManaged(svc.code) || currentState(svc.code) === 'running';
}

/** 走っているプロセスが名乗る版とディスクの版の突き合わせ (version-reconcile と同じ判定)。 */
async function serviceVersionStatus(svc: Service): Promise<VersionReconcileStatus> {
  const disk = (await resolveServiceRuntimeVersion(svc)).value;
  const row = db().get(sql`
    SELECT si.reported_version AS reported FROM service_instances si
    JOIN services s ON s.id = si.service_id WHERE s.code = ${svc.code} LIMIT 1
  `) as { reported: string | null } | undefined;
  return reconcileStatus(disk, row?.reported ?? null);
}

/** 反映で再起動するか (pure)。 一致していれば不要、 ずれている / 確かめられないなら再起動。 */
export function reflectNeedsRestart(status: VersionReconcileStatus): boolean {
  return status !== 'match';
}

export async function runServiceOperation(
  svc: Service,
  ctx: OperationContext,
  deps: ServiceOperationDeps = {},
): Promise<ExecutionOutcome> {
  const control = deps.control ?? controlStep;
  const isRunning = deps.isRunning ?? serviceIsRunning;
  const action = ctx.op.action;

  if (action === 'start' || action === 'stop' || action === 'restart') {
    const bad = recordSteps(ctx, [await control(svc, action, ctx.actor)]);
    return bad ? failedAt(bad) : succeeded();
  }

  if (action === 'reflect') return reflect(svc, ctx, deps, control, isRunning);

  // update / deploy は取り込みから始まる。 未コミット変更のある repo には触らない。
  const { ready, step } = await (deps.checkRepo ?? checkRepoReady)(svc);
  if (!ready) return failedAt(recordSteps(ctx, [step])!);
  const pulled = await (deps.fetch ?? fetchLatest)({
    source: ctx.op.source,
    repoDir: ready.repoDir,
    branch: ready.branch,
    repo: svc.repo ?? null,
    requester: ctx.requester,
  });
  const badPull = recordSteps(ctx, pulled);
  if (badPull) return failedAt(badPull);
  if (action === 'update') return succeeded();

  // 外部に出られない拠点 (mesh) は npm のキャッシュを優先する。 足りなければ install の失敗として表に出る。
  const installed = await (deps.install ?? installDependencies)(ready.repoDir, { preferOffline: ctx.op.source === 'mesh' });
  const badInstall = recordSteps(ctx, [installed]);
  if (badInstall) return failedAt(badInstall);
  const badBuild = recordSteps(ctx, [await (deps.build ?? buildService)(svc, ready.repoDir, 'auto')]);
  if (badBuild) return failedAt(badBuild);
  return restartIfRunning(svc, ctx, control, isRunning);
}

async function reflect(
  svc: Service,
  ctx: OperationContext,
  deps: ServiceOperationDeps,
  control: NonNullable<ServiceOperationDeps['control']>,
  isRunning: (svc: Service) => boolean,
): Promise<ExecutionOutcome> {
  const repoDir = repoDirOf(svc);
  if (!repoDir) return failed('repo: このサービスには checkout がありません');
  const build = await (deps.build ?? buildService)(svc, repoDir, 'auto');
  const bad = recordSteps(ctx, [build ?? { step: 'build', ok: true, detail: 'ビルド対象なし' }]);
  if (bad) return failedAt(bad);
  if (!isRunning(svc)) {
    ctx.record({ step: 'restart', ok: true, detail: '未起動のため再起動しない' });
    return succeeded();
  }
  const status = await (deps.versionStatus ?? serviceVersionStatus)(svc);
  if (!reflectNeedsRestart(status)) {
    ctx.record({ step: 'restart', ok: true, detail: '走っている版がディスクと一致しているため再起動しない' });
    return succeeded();
  }
  const restarted = recordSteps(ctx, [await control(svc, 'restart', ctx.actor)]);
  return restarted ? failedAt(restarted) : succeeded();
}

async function restartIfRunning(
  svc: Service,
  ctx: OperationContext,
  control: NonNullable<ServiceOperationDeps['control']>,
  isRunning: (svc: Service) => boolean,
): Promise<ExecutionOutcome> {
  if (!isRunning(svc)) {
    ctx.record({ step: 'restart', ok: true, detail: '未起動のため再起動しない' });
    return succeeded();
  }
  const bad = recordSteps(ctx, [await control(svc, 'restart', ctx.actor)]);
  return bad ? failedAt(bad) : succeeded();
}
