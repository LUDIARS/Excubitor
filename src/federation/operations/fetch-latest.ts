/**
 * 「最新を取り込む」 手順を、 拠点の取得元設定 (origin / mesh) に応じて選ぶ。
 */

import { fastForwardFromOrigin, type StepResult } from '../../update/steps.js';
import type { RemotePeer } from '../store.js';
import { fastForwardFromMesh } from './mesh-source.js';
import type { UpdateSource } from './types.js';

/** @implements SPEC-FEDERATION-MESH-SOURCE */

export interface FetchLatestInput {
  source: UpdateSource;
  repoDir: string;
  branch: string;
  /** catalog の repo (例 LUDIARS/Excubitor)。 mesh 取得元で依頼元の checkout を探すのに使う。 */
  repo: string | null;
  requester: RemotePeer | null;
}

export type FetchLatest = (input: FetchLatestInput) => Promise<StepResult[]>;

export const fetchLatest: FetchLatest = async (input) => {
  if (input.source === 'origin') return fastForwardFromOrigin(input.repoDir, input.branch);
  if (!input.requester) {
    return [{ step: 'mesh_source', ok: false, detail: '取得元が mesh ですが依頼元の拠点がありません (他拠点からの依頼でだけ使えます)' }];
  }
  if (!input.repo) {
    return [{ step: 'mesh_source', ok: false, detail: 'catalog に repo が無いため依頼元の checkout を特定できません' }];
  }
  return fastForwardFromMesh(input.requester, input.repo, input.repoDir, input.branch);
};
