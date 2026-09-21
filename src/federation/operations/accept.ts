/**
 * 依頼を受け付ける (検証 → 待ち行列へ積む)。 他拠点からの依頼と自拠点からの依頼で同じ手順を使う。
 */

import type { Catalog } from '../../catalog/loader.js';
import { readCoveragePrefs } from '../coverage-prefs.js';
import type { OperationRunner } from './runner.js';
import { toSummary } from './store.js';
import type { OperationSummary } from './types.js';
import { resolveUpdateSource } from './update-source.js';
import { validateOperationRequest } from './validate.js';

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

export function acceptOperation(body: unknown, catalog: Catalog, runner: OperationRunner, requester: Requester): AcceptResult {
  const checked = validateOperationRequest(body, catalog, readCoveragePrefs(), resolveUpdateSource());
  if (!checked.ok) return { ok: false, status: checked.status, error: checked.error, detail: checked.detail ?? null };
  const op = runner.enqueue({
    ...requester,
    target: checked.request.target,
    action: checked.request.action,
    source: checked.source,
  });
  return { ok: true, operation: toSummary(op) };
}
