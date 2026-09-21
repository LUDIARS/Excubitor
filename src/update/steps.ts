/**
 * サービスのリポジトリを更新・ビルドする個々の手順。
 *
 * ローカルの更新適用 (apply.ts) と拠点への依頼 (federation/operations) が同じ手順を使う。
 * 各手順は {step, ok, detail} を返し、 失敗しても throw しない (呼び出し側が中断を決める)。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCapture } from '../shared/exec.js';
import type { Service } from '../catalog/loader.js';
import { repoDirOf, checkUpdate } from './checker.js';

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 1_800_000;

export interface RepoReady {
  repoDir: string;
  branch: string;
}

/** 更新してよい状態か (git リポジトリ・未コミット変更なし・ブランチが特定できる)。 */
export async function checkRepoReady(svc: Service): Promise<{ ready: RepoReady | null; step: StepResult | null }> {
  const repoDir = repoDirOf(svc);
  if (!repoDir || !existsSync(`${repoDir}/.git`)) {
    return { ready: null, step: { step: 'repo', ok: false, detail: 'no git repository' } };
  }
  const status = await checkUpdate(svc, false);
  if (status.dirty) {
    return { ready: null, step: { step: 'dirty_check', ok: false, detail: '未コミット変更があるため中断 (手動で commit/stash してください)' } };
  }
  if (!status.branch) return { ready: null, step: { step: 'branch', ok: false, detail: 'ブランチを特定できません' } };
  return { ready: { repoDir, branch: status.branch }, step: null };
}

/**
 * origin から最新を取り込む: main を最新にし、 今の branch を origin/<branch> へ fast-forward する。
 * 最初に失敗した手順までを返す (以降は実行しない)。
 */
export async function fastForwardFromOrigin(repoDir: string, branch: string): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const main = await updateMainBranch(repoDir, branch);
  steps.push({ step: 'main', ok: main.ok, detail: tail(main.stderr || main.stdout || (main.ok ? '' : 'main update failed')) });
  if (!main.ok) return steps;

  const fetch = await execCapture('git', ['fetch', '--quiet', 'origin', branch], repoDir, GIT_TIMEOUT_MS);
  steps.push({ step: 'fetch', ok: fetch.ok, detail: tail(fetch.stderr || fetch.stdout) });
  if (!fetch.ok) return steps;

  const pull = await execCapture('git', ['merge', '--ff-only', `origin/${branch}`], repoDir, GIT_TIMEOUT_MS);
  steps.push({ step: 'pull', ok: pull.ok, detail: tail(pull.ok ? pull.stdout + pull.stderr : (pull.stderr || 'ff-only マージ不可 (分岐あり)')) });
  return steps;
}

async function updateMainBranch(repoDir: string, currentBranch: string) {
  const fetchMain = await execCapture('git', ['fetch', '--quiet', 'origin', 'main'], repoDir, GIT_TIMEOUT_MS);
  if (!fetchMain.ok) return fetchMain;
  if (currentBranch === 'main') {
    return execCapture('git', ['merge', '--ff-only', 'origin/main'], repoDir, GIT_TIMEOUT_MS);
  }
  return execCapture('git', ['fetch', '--quiet', 'origin', 'main:refs/heads/main'], repoDir, GIT_TIMEOUT_MS);
}

/** package.json があれば依存を入れる。 無ければ手順ごと省く (null)。 */
export async function installDependencies(
  repoDir: string,
  opts: { preferOffline?: boolean; prefix?: string } = {},
): Promise<StepResult | null> {
  const dir = opts.prefix ? join(repoDir, opts.prefix) : repoDir;
  if (!existsSync(join(dir, 'package.json'))) return null;
  const args = ['install', ...(opts.preferOffline ? ['--prefer-offline', '--no-audit', '--no-fund'] : [])];
  const npm = await execCapture('npm', args, dir, INSTALL_TIMEOUT_MS, true);
  return { step: opts.prefix ? `install:${opts.prefix}` : 'install', ok: npm.ok, detail: tail(npm.ok ? npm.stdout : npm.stderr) };
}

/**
 * ビルドの決め方:
 * - catalog の build_command があればそれ (ネイティブ / デスクトップ製品)
 * - mode='auto' なら、 package.json に scripts.build があるとき `npm run build`
 *   (dist 実行のサービスは git の取り込みだけでは反映されない)
 * ビルドするものが無ければ null。
 */
export async function buildService(svc: Service, repoDir: string, mode: 'catalog' | 'auto'): Promise<StepResult | null> {
  if (svc.build_command) {
    const build = await execCapture(svc.build_command, [], svc.cwd ?? repoDir, BUILD_TIMEOUT_MS, true);
    return { step: 'build', ok: build.ok, detail: tail(build.ok ? build.stdout : build.stderr) };
  }
  if (mode === 'auto' && hasBuildScript(svc.cwd ?? repoDir)) {
    return runNpmBuild(svc.cwd ?? repoDir);
  }
  return null;
}

/** `npm run build` (prefix 指定でサブディレクトリ)。 */
export async function runNpmBuild(dir: string, prefix?: string): Promise<StepResult> {
  const cwd = prefix ? join(dir, prefix) : dir;
  const build = await execCapture('npm', ['run', 'build'], cwd, BUILD_TIMEOUT_MS, true);
  return { step: prefix ? `build:${prefix}` : 'build', ok: build.ok, detail: tail(build.ok ? build.stdout : build.stderr) };
}

export function hasBuildScript(dir: string): boolean {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return false;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.build === 'string';
  } catch {
    // 壊れた package.json はビルド対象としない (install 側で失敗として表に出る)。
    return false;
  }
}

export function tail(s: string): string {
  const t = s.trim();
  return t.length > 800 ? '…' + t.slice(-800) : t;
}
