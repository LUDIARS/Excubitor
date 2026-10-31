/**
 * Test guard: fail any filesystem write that targets the developer's real Excubitor config dir.
 * The test setup redirects every config path to a temp dir; this guard catches code that still
 * resolves a real path (a missed env var, a cached path, a new default), so a test can never
 * re-encrypt or replace the site's real config.enc / master key / tokens.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

type Env = Record<string, string | undefined>;

/** Real Excubitor locations derived from the environment before the test setup overrides it. */
export function realExcubitorDirs(env: Env): string[] {
  const base = env.APPDATA ?? env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const dirs = [join(base, 'Excubitor')];
  if (env.EXCUBITOR_CONFIG_PATH) dirs.push(resolve(env.EXCUBITOR_CONFIG_PATH, '..'));
  if (env.EXCUBITOR_MASTER_KEY_DIR) dirs.push(env.EXCUBITOR_MASTER_KEY_DIR);
  return dirs.map((d) => resolve(d));
}

export function isInsideAny(target: string, dirs: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const t = norm(target);
  return dirs.some((d) => {
    const dir = norm(d);
    return t === dir || t.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  });
}

function isWriteFlag(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return false;
}

/** Wrap fs write entry points so a write into `dirs` throws instead of touching real data. */
export function installRealConfigWriteGuard(dirs: readonly string[]): void {
  const check = (p: unknown, op: string) => {
    if ((typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) && isInsideAny(String(p instanceof URL ? p.pathname : p), dirs)) {
      throw new Error(`test guard: refused ${op} into the real Excubitor config dir (${String(p)}). Point the test at a temp dir.`);
    }
  };
  type AnyFn = (...args: unknown[]) => unknown;
  const wrap = (target: Record<string, unknown>, name: string, pathArgs: number[], onlyWhenWriteFlag = false, returnsPromise = false) => {
    const original = target[name] as AnyFn | undefined;
    if (typeof original !== 'function') return;
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      try {
        if (!onlyWhenWriteFlag || isWriteFlag(args[1] ?? 'r')) {
          for (const i of pathArgs) check(args[i], name);
        }
      } catch (err) {
        if (returnsPromise) return Promise.reject(err);
        throw err;
      }
      return original.apply(this, args);
    };
  };
  const fsAny = fs as unknown as Record<string, unknown>;
  for (const name of ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'truncateSync', 'truncate', 'chmodSync', 'chmod']) {
    wrap(fsAny, name, [0]);
  }
  for (const name of ['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp']) wrap(fsAny, name, [0, 1]);
  wrap(fsAny, 'openSync', [0], true);
  wrap(fsAny, 'open', [0], true);
  wrap(fsAny, 'createWriteStream', [0]);
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const name of ['writeFile', 'appendFile', 'unlink', 'rm', 'truncate', 'chmod']) wrap(promises, name, [0], false, true);
  for (const name of ['rename', 'copyFile', 'cp']) wrap(promises, name, [0, 1], false, true);
  wrap(promises, 'open', [0], true, true);
  // ESM の named import (`import { writeFileSync } from 'node:fs'`) にも差し替えを反映する。
  syncBuiltinESMExports();
}
