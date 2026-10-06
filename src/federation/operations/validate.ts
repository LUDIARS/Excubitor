/**
 * 依頼を受け付けてよいかの判定 (受け付け時点で弾く。 実行時まで持ち越さない)。
 *
 * - 本文が契約どおり (target + action)
 * - Excubitor 自身には update / restart / deploy / reflect だけ
 * - サービスは本拠点の catalog にあり、 本拠点が担保している (担保しないと上書きしたサービスは断る)
 * - catalog に無いサービスへの update / deploy は、 bootstrap 指定が添えてあれば bootstrap として受ける
 *   (2026-10-06 neco: 本社→他拠点デプロイはすべて許可)
 * - 取得元の設定 (EXCUBITOR_UPDATE_SOURCE) が読める。 取得元が mesh でも bootstrap を受ける
 *   (依頼元から bundle で clone する。 依頼元の有無は preflight が見る)
 */

import type { Catalog } from '../../catalog/loader.js';
import { OperationRequestSchema, isActionAllowed, type OperationRequest, type UpdateSource } from './types.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export type ValidationResult =
  | { ok: true; request: OperationRequest; source: UpdateSource }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string; detail?: unknown };

/** catalog に無いサービスへの update / deploy を bootstrap に読み替える (pure)。 読み替えられなければ null。 */
export function asBootstrapForMissingService(request: OperationRequest): OperationRequest | null {
  if (request.action === 'bootstrap') return request;
  if ((request.action === 'update' || request.action === 'deploy') && request.bootstrap) {
    return { ...request, action: 'bootstrap' };
  }
  return null;
}

export function validateOperationRequest(
  body: unknown,
  catalog: Pick<Catalog, 'services'>,
  coveragePrefs: ReadonlyMap<string, boolean>,
  source: UpdateSource | null,
): ValidationResult {
  const parsed = OperationRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: 'invalid_body', detail: parsed.error.flatten() };
  let request = parsed.data;
  if (!isActionAllowed(request.target, request.action)) {
    return { ok: false, status: 400, error: 'action_not_allowed_for_target' };
  }
  if (request.target.kind === 'service') {
    const code = request.target.code;
    const entry = catalog.services.find((s) => s.code === code);
    if (!entry) {
      const converted = asBootstrapForMissingService(request);
      if (!converted) return { ok: false, status: 404, error: 'service_not_found' };
      request = converted;
    } else if (entry.disabled && request.action !== 'bootstrap') {
      return { ok: false, status: 404, error: 'service_not_found' };
    }
    if (coveragePrefs.get(code) === false) return { ok: false, status: 409, error: 'service_not_covered_by_this_node' };
  }
  if (request.target.kind === 'service'
      && ['excubitor', 'excubitor-viewer-dmz'].includes(request.target.code)
      && ['update', 'deploy', 'reflect'].includes(request.action)) {
    return { ok: false, status: 409, error: 'use_excubitor_service_target', detail: { target: { kind: 'excubitor' }, action: request.action } };
  }
  if (!source) return { ok: false, status: 500, error: 'invalid_update_source_config' };
  return { ok: true, request, source };
}
