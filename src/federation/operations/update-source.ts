/**
 * この拠点が更新 (update / deploy) の取得元をどこにするか。 拠点ごとの env で決める。
 *
 * - EXCUBITOR_UPDATE_SOURCE=origin (既定): git remote (GitHub 等) から取り込む
 * - EXCUBITOR_UPDATE_SOURCE=mesh: 外部に出られない拠点用。 依頼元拠点から git bundle を受け取る
 *
 * 値が不正なら null を返し、 依頼は受け付けない (既定値へ黙って落とさない)。
 */

import { UpdateSourceSchema, type UpdateSource } from './types.js';

/** @implements SPEC-FEDERATION-MESH-SOURCE */

export const UPDATE_SOURCE_ENV = 'EXCUBITOR_UPDATE_SOURCE';

export function resolveUpdateSource(env: Record<string, string | undefined> = process.env): UpdateSource | null {
  const raw = env[UPDATE_SOURCE_ENV]?.trim();
  if (!raw) return 'origin';
  const parsed = UpdateSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
