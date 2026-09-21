/**
 * 受けた依頼を、 受け付けた順に 1 件ずつ実行する。
 *
 * デプロイ同士が重なるとビルドや再起動が衝突するので、 並べずに直列で回す。 待ち行列の正本は DB
 * (status = queued) で、 Excubitor が再起動しても続きから実行する。
 *
 * 起動時 (recover):
 * - running のまま残った依頼は、 実行中に Excubitor が止まったので failed にする
 * - restarting の依頼 (自己再起動) は、 起動した版が期待どおりなら succeeded、 違えば failed
 * - queued は残っていれば実行を始める
 */

import type { Catalog } from '../../catalog/loader.js';
import { createNamedLogger } from '../../shared/logger.js';
import type { StepResult } from '../../update/steps.js';
import { getPeer, type RemotePeer } from '../store.js';
import type { ExecutionOutcome, OperationContext } from './context.js';
import { runSelfOperation, selfRepoOf } from './self-operation.js';
import { runServiceOperation } from './service-operation.js';
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
  if (op.target.kind === 'excubitor') return runSelfOperation(selfRepoOf(catalog), ctx);
  const code = op.target.code;
  const svc = catalog.services.find((s) => s.code === code);
  if (!svc) return { kind: 'finished', ok: false, error: `service ${code} は catalog にありません` };
  return runServiceOperation(svc, ctx);
};

export interface OperationRunnerDeps {
  getCatalog: () => Catalog;
  now?: () => number;
  execute?: OperationExecutor;
  findPeer?: (id: string) => RemotePeer | null;
}

export interface OperationRunner {
  enqueue: (input: Omit<NewOperation, 'now'>) => OperationRecord;
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
  let active: Promise<void> | null = null;
  let stopped = false;

  const runOne = async (op: OperationRecord): Promise<ExecutionOutcome> => {
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
    }
  };

  const drain = async (): Promise<void> => {
    while (!stopped) {
      const next = listByStatus('queued')[0];
      if (!next) return;
      logger.info({ id: next.id, target: next.target, action: next.action, by: next.requested_by }, 'operation started');
      const outcome = await runOne(next);
      if (outcome.kind === 'restarting') {
        // backend はまもなく止まる。 残りの依頼は再起動後の recover から続ける。
        logger.info({ id: next.id }, 'operation handed off to self restart');
        return;
      }
      finishOperation(next.id, outcome.ok, outcome.error, now());
      logger.info({ id: next.id, ok: outcome.ok, error: outcome.error }, 'operation finished');
    }
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
    enqueue: (input) => {
      const op = createOperation({ ...input, now: now() });
      kick();
      return op;
    },
    recover: (bootHash) => {
      for (const op of listByStatus('running')) {
        appendStep(op.id, { step: 'interrupted', ok: false, detail: '実行中に Excubitor が止まった' });
        finishOperation(op.id, false, 'interrupted: 実行中に Excubitor が止まった', now());
      }
      for (const op of listByStatus('restarting')) {
        const expected = typeof op.meta.expected_hash === 'string' ? op.meta.expected_hash : null;
        const ok = expected !== null && expected === bootHash;
        const detail = ok
          ? `再起動して ${bootHash} で起動した`
          : `再起動後の版 ${bootHash ?? 'unknown'} が期待した ${expected ?? 'unknown'} と違う`;
        appendStep(op.id, { step: 'restart', ok, detail });
        finishOperation(op.id, ok, ok ? null : `restart: ${detail}`, now());
      }
      kick();
    },
    idle: async () => {
      while (active) await active;
    },
    stop: () => {
      stopped = true;
    },
  };
}
