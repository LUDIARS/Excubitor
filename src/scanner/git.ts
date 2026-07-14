import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface GitInfo {
  branch: string | null;
  hash: string | null;
  dirty: boolean | null;
  package_version: string | null;
}

/**
 * catalog.cwd 縺ｮ git/package 諠・ｱ繧貞叙蠕励☆繧九・
 * - 蜿門ｾ怜､ｱ謨・(cwd 辟｡縺・/ git 辟｡縺・ 縺ｯ null 繧定ｿ斐☆
 * - 蟄舌・繝ｭ繧ｻ繧ｹ縺ｮ timeout 縺ｯ 5 遘・
 */
export async function readGitInfo(cwd: string): Promise<GitInfo> {
  const [branch, hash, dirty, version] = await Promise.all([
    safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    safeExec('git', ['rev-parse', '--short=12', 'HEAD'], cwd),
    safeExec('git', ['status', '--porcelain'], cwd).then((s) => s !== null ? s.length > 0 : null),
    readPackageVersion(cwd),
  ]);

  return {
    branch: branch?.trim() || null,
    hash: hash?.trim() || null,
    dirty,
    package_version: version,
  };
}

async function readPackageVersion(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function safeExec(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    let stdout = '';
    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      resolveP(null);
    }, 5000);
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.on('error', () => { clearTimeout(timeout); resolveP(null); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolveP(code === 0 ? stdout : null);
    });
  });
}


