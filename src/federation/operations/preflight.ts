/**
 * 受け付け前の事前確認 (取り込みを伴う update / deploy だけ)。
 *
 * 実行してから失敗する条件を、 受け付け時点で 409 + エラーコードとして返す。
 * 依頼元は待ち行列へ積まれた後に結果を見に行かなくても、 断られた理由を応答で受け取れる。
 * 実行時の同じ確認 (service-operation / self-operation / mesh-source) は、 受け付け後に
 * 状態が変わった場合の保険として残す。
 *
 * - dirty_worktree:          未コミット変更がある
 * - git_status_unavailable:  git の状態を読めない
 * - detached_head:           ブランチを特定できない
 * - not_fast_forward:        手元に取り込み元より先行したコミットがある (fast-forward できない)
 * - mesh_source_unavailable: 取得元が mesh なのに依頼元の拠点か catalog の repo が無い
 * - repo_not_found:          サービスに git checkout が無い
 */

import type { Catalog, Service } from '../../catalog/loader.js';
import { readGitDirty } from '../../scanner/git.js';
import { execCapture } from '../../shared/exec.js';
import { checkRepoReady } from '../../update/steps.js';
import { readCurrentHead } from '../self-version.js';
import { MESH_REMOTE_REF } from './mesh-source.js';
import { selfRepoOf } from './self-operation.js';
import type { OperationRequest, UpdateSource } from './types.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export type PreflightResult =
  | { ok: true }
  | { ok: false; status: 409; error: PreflightError; detail: string };

export type PreflightError =
  | 'dirty_worktree'
  | 'git_status_unavailable'
  | 'detached_head'
  | 'not_fast_forward'
  | 'mesh_source_unavailable'
  | 'repo_not_found';

export interface PreflightInput {
  request: OperationRequest;
  source: UpdateSource;
  catalog: Pick<Catalog, 'services'>;
  /** 本拠点での依頼元ピア id (自拠点からなら null)。 */
  requesterPeerId: string | null;
}

export interface PreflightDeps {
  checkRepo?: (svc: Service) => Promise<{ ready: { repoDir: string; branch: string } | null; step: { step: string } | null }>;
  isDirty?: (dir: string) => Promise<boolean | null>;
  readHead?: (dir: string) => Promise<{ branch: string | null }>;
  /** `<ref>..HEAD` の件数。 ref が無い・読めないときは null (確かめられないので断らない)。 */
  countAhead?: (repoDir: string, ref: string) => Promise<number | null>;
}

const GIT_TIMEOUT_MS = 15_000;

async function countAheadOf(repoDir: string, ref: string): Promise<number | null> {
  const r = await execCapture('git', ['rev-list', '--count', `${ref}..HEAD`], repoDir, GIT_TIMEOUT_MS);
  if (!r.ok) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function reject(error: PreflightError, detail: string): PreflightResult {
  return { ok: false, status: 409, error, detail };
}

/** 取り込み元の ref (pure)。 origin は origin/<branch>、 mesh は依頼元から受け取った main。 */
export function upstreamRefFor(source: UpdateSource, branch: string): string {
  return source === 'origin' ? `origin/${branch}` : MESH_REMOTE_REF;
}

/** 取り込みを伴う依頼か (pure)。 */
export function needsPreflight(request: OperationRequest): boolean {
  return request.action === 'update' || request.action === 'deploy';
}

export async function preflightOperation(input: PreflightInput, deps: PreflightDeps = {}): Promise<PreflightResult> {
  const { request, source, catalog } = input;
  if (!needsPreflight(request)) return { ok: true };
  const countAhead = deps.countAhead ?? countAheadOf;

  let repo: string | null;
  let repoDir: string;
  let branch: string;
  if (request.target.kind === 'service') {
    const code = request.target.code;
    const svc = catalog.services.find((s) => s.code === code);
    if (!svc) return { ok: true }; // 存在確認は validate の責務
    repo = svc.repo ?? null;
    const { ready, step } = await (deps.checkRepo ?? checkRepoReady)(svc);
    if (!ready) {
      if (step?.step === 'repo') return reject('repo_not_found', `${code} に git checkout がありません`);
      if (step?.step === 'dirty_check') return reject('dirty_worktree', `${code} に未コミット変更があります`);
      return reject('detached_head', `${code} のブランチを特定できません`);
    }
    repoDir = ready.repoDir;
    branch = ready.branch;
  } else {
    const self = selfRepoOf(catalog);
    repo = self.repo;
    const dirty = await (deps.isDirty ?? readGitDirty)(self.dir);
    if (dirty === null) return reject('git_status_unavailable', 'Excubitor の git の状態を確認できません');
    if (dirty) return reject('dirty_worktree', 'Excubitor に未コミット変更があります');
    const head = await (deps.readHead ?? readCurrentHead)(self.dir);
    if (!head.branch || head.branch === 'HEAD') return reject('detached_head', 'Excubitor のブランチを特定できません');
    repoDir = self.dir;
    branch = head.branch;
  }

  if (source === 'mesh') {
    if (!input.requesterPeerId) return reject('mesh_source_unavailable', '取得元が mesh ですが依頼元の拠点がありません (他拠点からの依頼でだけ使えます)');
    if (!repo) return reject('mesh_source_unavailable', 'catalog に repo が無いため依頼元の checkout を特定できません');
  }

  const ahead = await countAhead(repoDir, upstreamRefFor(source, branch));
  if (ahead !== null && ahead > 0) {
    return reject('not_fast_forward', `手元に取り込み元より先行したコミットが ${ahead} 件あります (fast-forward できません)`);
  }
  return { ok: true };
}
