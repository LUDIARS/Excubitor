/**
 * 受けた依頼を、 受け付けた順に 1 件ずつ実行する。
 *
 * デプロイ同士が重なるとビルドや再起動が衝突するので、 並べずに直列で回す。 待ち行列の正本は DB
 * (status = queued) で、 Excubitor が再起動しても続きから実行する。
 *
 * 起動時 (recover):
 * - running のまま残った依頼は、 実行中に Excubitor が止まったので failed にする
 * - restarting の依頼 (自己再起動) は、 backend・supervisor・ExView の復旧を確認して succeeded、 失敗なら failed
 * - queued は残っていれば実行を始める
 */

import { runBootstrapOperation } from '../../bootstrap/operation.js';
import { beginManualUpdate, endManualUpdate } from '../../update/daily/store.js';
import type { Catalog } from '../../catalog/loader.js';
import { createNamedLogger } from '../../shared/logger.js';
import type { StepResult } from '../../update/steps.js';
import { getPeer, type RemotePeer } from '../store.js';
import type { ExecutionOutcome, OperationContext } from './context.js';
import { CONCORDIA_SITE_ACTION, runConcordiaSiteOperation } from './concordia-site.js';
import { recoverSelfService } from './self-recovery.js';
import { runSelfOperation, selfRepoOf } from './self-operation.js';
import { runServiceOperation } from './service-operation.js';
import { runStashOperation } from './stash-operation.js';
import {
  appendStep,
  createOperation,
  finishOperation,
  listByStatus,
  markRunning,
  type NewOperation,
  type OperationRecord,
} from './store.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

const logger = createNamedLogger('excubitor.federation.operations');

export type OperationExecutor = (op: OperationRecord, ctx: OperationContext, catalog: Catalog) => Promise<ExecutionOutcome>;

export const executeOperation: OperationExecutor = async (op, ctx, catalog) => {
  if (op.action === 'stash') return runStashOperation(ctx, catalog);
  if (op.target.kind === 'excubitor') return runSelfOperation(selfRepoOf(catalog), ctx);
  const code = op.target.code;
  const svc = catalog.services.find((s) => s.code === code);
  if (['bootstrap', 'data-export', 'data-import'].includes(op.action)) return runBootstrapOperation(ctx, svc);
  if (op.action === CONCORDIA_SITE_ACTION) return runConcordiaSiteOperation(ctx, svc);
  if (!svc) return { kind: 'finished', ok: false, error: `service ${code} は catalog にありません` };
  return runServiceOperation(svc, ctx);
};

export interface OperationRunnerDeps {
  getCatalog: () => Catalog;
  now?: () => number;
  execute?: OperationExecutor;
  recoverSelf?: typeof recoverSelfService;
  findPeer?: (id: string) => RemotePeer | null;
  /** 日次更新の実行中に順番が来た依頼を、 待ち行列に残したまま再試行するまでの間隔 (ms)。 */
  dailyRetryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** 日次更新の実行中は依頼を失敗にせず、 待ち行列に残して後で再試行する (2026-10-06 neco)。 */
export const DEFAULT_DAILY_RETRY_MS = 30_000;
type RunOutcome = ExecutionOutcome | { kind: 'deferred' };

export interface OperationRunner {
  /** onCreated は記録を作った直後・実行を始める前に呼ぶ (記録に残さない値をメモリへ預ける用)。 */
  enqueue: (input: Omit<NewOperation, 'now'>, onCreated?: (op: OperationRecord) => void) => OperationRecord;
  /** 起動時に 1 回。 bootHash は起動した Excubitor の git hash。 */
  recover: (bootHash: string | null) => void;
  /** 今ある待ち行列を処理し終えるまで待つ (テスト / shutdown 用)。 */
  idle: () => Promise<void>;
  stop: () => void;
}

export function createOperationRunner(deps: OperationRunnerDeps): OperationRunner {
  const now = deps.now ?? Date.now;
  const execute = deps.execute ?? executeOperation;
  const findPeer = deps.findPeer ?? getPeer;
  const dailyRetryMs = deps.dailyRetryMs ?? DEFAULT_DAILY_RETRY_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  let active: Promise<void> | null = null;
  let stopped = false;
  let retryScheduled = false;

  const runOne = async (op: OperationRecord): Promise<RunOutcome> => {
    if (!beginManualUpdate(op.id)) return { kind: 'deferred' };
    markRunning(op.id, now());
    const ctx: OperationContext = {
      op,
      actor: op.requester_peer_id ? `federation:${op.requested_by}` : 'local',
      requester: op.requester_peer_id ? findPeer(op.requester_peer_id) : null,
      record: (step: StepResult) => appendStep(op.id, step),
    };
    try {
      return await execute(op, ctx, deps.getCatalog());
    } catch (err) {
      return { kind: 'finished', ok: false, error: `unexpected: ${(err as Error).message}` };
    } finally {
      endManualUpdate(op.id);
    }
  };

  const drain = async (): Promise<void> => {
    while (!stopped) {
      const next = listByStatus('queued')[0];
      if (!next) return;
      logger.info({ id: next.id, target: next.target, action: next.action, by: next.requested_by }, 'operation started');
      const outcome = await runOne(next);
      if (outcome.kind === 'deferred') {
        // 順番は変えない (先頭のまま残す)。 日次更新が終わったころに続きから処理する。
        logger.info({ id: next.id, retry_ms: dailyRetryMs }, 'operation deferred while daily update is active');
        scheduleRetry();
        return;
      }
      if (outcome.kind === 'restarting') {
        // backend はまもなく止まる。 残りの依頼は再起動後の recover から続ける。
        logger.info({ id: next.id }, 'operation handed off to self restart');
        return;
      }
      finishOperation(next.id, outcome.ok, outcome.error, now());
      logger.info({ id: next.id, ok: outcome.ok, error: outcome.error }, 'operation finished');
    }
  };

  const scheduleRetry = (): void => {
    if (retryScheduled || stopped) return;
    retryScheduled = true;
    setTimer(() => {
      retryScheduled = false;
      kick();
    }, dailyRetryMs);
  };

  const kick = (): void => {
    if (active || stopped) return;
    active = drain()
      .catch((err) => logger.warn({ err: (err as Error).message }, 'operation runner failed'))
      .finally(() => {
        active = null;
      });
  };

  return {
    enqueue: (input, onCreated) => {
      const op = createOperation({ ...input, now: now() });
      onCreated?.(op);
      kick();
      return op;
    },
    recover: (bootHash) => {
      for (const op of listByStatus('running')) {
        appendStep(op.id, { step: 'interrupted', ok: false, detail: '実行中に Excubitor が止まった' });
        finishOperation(op.id, false, 'interrupted: 実行中に Excubitor が止まった', now());
      }
      active = (async () => {
        for (const op of listByStatus('restarting')) {
          const expected = typeof op.meta.expected_hash === 'string' ? op.meta.expected_hash : null;
          let error: string | null = expected && expected === bootHash
            ? null : '再起動後の版 ' + (bootHash ?? 'unknown') + ' が期待した ' + (expected ?? 'unknown') + ' と違う';
          if (!error && expected) {
            try {
              await (deps.recoverSelf ?? recoverSelfService)(op, expected, deps.getCatalog(), () => stopped);
            } catch (failure) {
              error = failure instanceof Error ? failure.message : String(failure);
            }
          }
          const detail = error ?? 'Excubitor サービス本体を ' + expected + ' で更新しました';
          appendStep(op.id, { step: 'restart', ok: error === null, detail });
          finishOperation(op.id, error === null, error ? 'restart: ' + error : null, now());
        }
        if (!stopped) await drain();
      })().catch((error: unknown) => {
        logger.error({ err: error instanceof Error ? error.message : String(error) }, 'self-service recovery failed');
      }).finally(() => { active = null; });
    },
    idle: async () => {
      while (active) await active;
    },
    stop: () => {
      stopped = true;
    },
  };
}
