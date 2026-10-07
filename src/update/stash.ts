import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execCapture, type ExecResult } from '../shared/exec.js';
import { DIRTY_STATUS_ARGS } from './checker.js';
import { findGitRoot, type StepResult } from './steps.js';

/** @implements SPEC-FEDERATION-OPERATIONS */
const TIMEOUT_MS = 60_000;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
type GitRun = (args: string[], cwd: string) => Promise<ExecResult>;

const runGit: GitRun = (args, cwd) => execCapture('git', args, cwd, TIMEOUT_MS);
const receipt = (result: ExecResult): string | null => result.ok && /^[a-f0-9]{40,64}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
const failure = (detail: string): StepResult => ({ step: 'stash', ok: false, detail });

/** Stash only an explicitly selected primary checkout; never fetch, restart, pop or drop. */
export async function stashWorkingTree(workDir: string, operationId: string, git: GitRun = runGit): Promise<StepResult[]> {
  const root = findGitRoot(workDir);
  if (!root || !lstatSync(join(root, '.git')).isDirectory()) return [failure('退避対象はサービス本体の git checkout に限定されています')];
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) return [failure('操作 ID が不正です')];
  if (IN_PROGRESS.some(name => existsSync(join(root, '.git', name)))) return [failure('merge/rebase 等の途中のため退避できません')];
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (!branch.ok || !branch.stdout.trim()) return [failure('対象 branch を確認できません')];
  const conflicts = await git(['ls-files', '--unmerged', '-z'], root);
  if (!conflicts.ok || conflicts.stdout) return [failure('競合を解消してから退避してください')];
  const status = await git([...DIRTY_STATUS_ARGS, '-z'], root);
  if (!status.ok) return [failure('未コミット変更を確認できません')];
  if (!status.stdout) return [{ step: 'stash', ok: true, detail: '退避する変更はありません' }];
  const before = await git(['rev-parse', '--verify', '--quiet', 'refs/stash'], root);
  if ((!before.ok && before.code !== 1) || (before.ok && !receipt(before))) return [failure('既存の stash を確認できません')];
  const message = `Excubitor operation ${operationId}`;
  const saved = await git(['stash', 'push', '--include-untracked', '--message', message], root);
  // Always inspect the ref even after failure: Git may save the commit before cleanup fails.
  // Output can contain user data; persist only the receipt, never stdout/stderr or diff contents.
  const after = await git(['rev-parse', '--verify', '--quiet', 'refs/stash'], root);
  const hash = receipt(after);
  const subject = hash ? await git(['show', '-s', '--format=%s', hash], root) : null;
  const created = hash !== null && hash !== receipt(before) && subject?.ok === true && subject.stdout.trim().endsWith(`: ${message}`);
  const detail = created ? `stash commit ${hash}` : '新しい stash commit を確認できません';
  if (!saved.ok || !created) return [failure(`${detail}; 退避処理が完了していません。状態を確認し、自動で再実行しないでください`)];
  const steps: StepResult[] = [{ step: 'stash', ok: true, detail }];
  const remaining = await git([...DIRTY_STATUS_ARGS, '-z'], root);
  steps.push({ step: 'stash_verify', ok: remaining.ok && !remaining.stdout, detail: !remaining.ok
    ? '退避後の状態を確認できません。stash commit は保持しています'
    : remaining.stdout ? '変更が残っています。stash commit は保持しています (submodule/入れ子のリポジトリ内は退避対象外)'
      : '追跡済み変更と未追跡ファイルを退避しました (ignored ファイル・submodule 内は対象外)' });
  return steps;
}
