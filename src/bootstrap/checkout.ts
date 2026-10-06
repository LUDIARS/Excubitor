import { lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execCapture } from '../shared/exec.js';
import { arsRoot } from '../shared/roots.js';
import { bootstrapCheckoutName } from './repository.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export async function directory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a real directory: ' + path);
  const actual = await realpath(path);
  const canonical = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (canonical(actual) !== canonical(path)) throw new Error('Symlink ancestor is not allowed: ' + path);
  return actual;
}

/** 空の target へ main を clone する手段。 既定は GitHub (origin)、 mesh 拠点は依頼元の bundle。 */
export type CheckoutCloner = (repository: string, target: string, root: string) => Promise<void>;

export const cloneFromGithub: CheckoutCloner = async (repository, target, root) => {
  // No supplied URL, ref, shell, or recursive submodule execution. Incomplete clones are kept for inspection.
  const result = await execCapture('git', ['-c', 'credential.interactive=false', 'clone', '--branch', 'main', '--single-branch', '--',
    'https://github.com/' + repository + '.git', target], root, 300_000);
  if (!result.ok) throw new Error('clone failed; inspect checkout and Git credentials on the destination');
};

export async function serviceCheckout(repository: string, clone: boolean, cloner: CheckoutCloner = cloneFromGithub): Promise<string> {
  const name = bootstrapCheckoutName(repository);
  const root = await directory(arsRoot());
  if (['excubitor', 'castra'].includes(name.toLowerCase())) throw new Error('Bootstrap cannot clone Excubitor or the workspace root');
  const target = join(root, name);
  let exists = true;
  try { await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) {
    if (!clone) throw new Error('Checkout is missing');
    await mkdir(target, { mode: 0o750 });
  }
  await directory(target);
  if ((await readdir(target)).length === 0 && clone) await cloner(repository, target, root);
  await directory(join(target, '.git'));
  const origin = await execCapture('git', ['remote', 'get-url', 'origin'], target);
  if (!origin.ok || origin.stdout.trim() !== 'https://github.com/' + repository + '.git') throw new Error('Checkout origin mismatch');
  const branch = await execCapture('git', ['branch', '--show-current'], target);
  if (!branch.ok || branch.stdout.trim() !== 'main') throw new Error('Checkout must be on main');
  const status = await execCapture('git', ['status', '--porcelain'], target);
  if (!status.ok || status.stdout.trim()) throw new Error('Checkout is dirty; no automatic reset or pull');
  return target;
}
