/**
 * 依頼を受け付ける (検証 → 事前確認 → 待ち行列へ積む)。 他拠点からの依頼と自拠点からの依頼で同じ手順を使う。
 * 日次更新の実行中でも断らない。 待ち行列に積み、 runner が日次更新の完了を待って実行する。
 */

import type { Catalog } from '../../catalog/loader.js';
import { readCoveragePrefs } from '../coverage-prefs.js';
import type { OperationRunner } from './runner.js';
import { holdSiteToken, publicSiteMeta } from './concordia-site.js';
import { appendStep, toSummary } from './store.js';
import type { OperationSummary } from './types.js';
import { resolveUpdateSource } from './update-source.js';
import { validateOperationRequest } from './validate.js';
import { preflightOperation, type PreflightDeps } from './preflight.js';
import { activeDailyRun } from '../../update/daily/store.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export type AcceptResult =
  | { ok: true; operation: OperationSummary }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string; detail: unknown };

export interface Requester {
  /** 依頼元の表示名 (他拠点なら名乗った拠点名、 自拠点なら 'local')。 */
  requestedBy: string;
  /** 本拠点での登録ピア id (自拠点からなら null)。 */
  requesterPeerId: string | null;
}

export async function acceptOperation(
  body: unknown,
  catalog: Catalog,
  runner: OperationRunner,
  requester: Requester,
  preflightDeps?: PreflightDeps,
): Promise<AcceptResult> {
  const checked = validateOperationRequest(body, catalog, readCoveragePrefs(), resolveUpdateSource());
  if (!checked.ok) return { ok: false, status: checked.status, error: checked.error, detail: checked.detail ?? null };
  // 実行してから失敗する条件 (未コミット変更 / 分岐 / detached / mesh 取得元不在) は受け付け時点で断る。
  const pre = await preflightOperation(
    { request: checked.request, source: checked.source, catalog, requesterPeerId: requester.requesterPeerId },
    preflightDeps,
  );
  if (!pre.ok) return { ok: false, status: pre.status, error: pre.error, detail: pre.detail };
  const site = checked.request.federation_site;
  // token は記録 (meta) に残さず、 enqueue と同じ同期区間でメモリに預ける (runner が実行時に取り出す)。
  const op = runner.enqueue({
    ...requester,
    target: checked.request.target,
    action: checked.request.action,
    source: checked.source,
    meta: {
      bootstrap: checked.request.bootstrap,
      data: checked.request.data,
      ...(site ? { federation_site: publicSiteMeta(site) } : {}),
    },
  }, site ? (created) => holdSiteToken(created.id, site.token) : undefined);
  if (activeDailyRun()) {
    appendStep(op.id, { step: 'queued', ok: true, detail: '日次更新の実行中のため、完了してから実行します' });
  }
  return { ok: true, operation: toSummary(op) };
}
