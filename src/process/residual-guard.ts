import { resolve } from 'node:path';
import { readdir, readlink } from 'node:fs/promises';

import { listProcesses, type ProcEntry } from '../memory/process-sampler.js';
import { execCapture } from '../shared/exec.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.process.residual-guard');

export interface ResidualProcessGuardDeps {
  kill: (pid: number) => Promise<void>;
  processes?: () => Promise<ProcEntry[] | null>;
  workingDirectories?: () => Promise<Map<number, string>>;
}

export interface ResidualProcessGuardResult {
  stoppedPids: number[];
}

/** `lsof` の machine-readable cwd 一覧を PID -> cwd に変換する。 */
export function parseLsofWorkingDirectories(raw: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (pid !== null && line.startsWith('n')) {
      result.set(pid, line.slice(1));
    }
  }
  return result;
}

/** 同じ cwd で同じ起動 command を持つ旧 supervisor 管理プロセスを group 単位で回収する。 */
export async function clearResidualServiceProcesses(
  code: string,
  cwd: string | undefined,
  command: string,
  protectedPid: number | undefined,
  deps: ResidualProcessGuardDeps,
): Promise<ResidualProcessGuardResult> {
  if (process.platform === 'win32' || !cwd) return { stoppedPids: [] };

  const processes = await (deps.processes ?? listProcesses)();
  if (!processes) {
    throw new Error(`service ${code}: cannot verify residual processes because process listing failed`);
  }
  const workingDirectories = await (deps.workingDirectories ?? listWorkingDirectories)();
  const expectedCwd = resolve(cwd);
  const matching = processes.filter((entry) =>
    entry.pid !== process.pid
    && entry.pid !== protectedPid
    && workingDirectories.get(entry.pid) === expectedCwd
    && commandMatches(entry.commandLine, command),
  );
  const matchingPids = new Set(matching.map((entry) => entry.pid));
  const roots = matching.filter((entry) => !matchingPids.has(entry.ppid));
  if (roots.length === 0) return { stoppedPids: [] };

  logger.warn(
    { code, cwd: expectedCwd, command, pids: roots.map((entry) => entry.pid) },
    'residual service processes found; stopping process groups before spawn',
  );
  const stoppedPids: number[] = [];
  for (const entry of roots) {
    await deps.kill(entry.pid);
    stoppedPids.push(entry.pid);
  }
  return { stoppedPids };
}

function commandMatches(commandLine: string | undefined, expected: string): boolean {
  if (!commandLine) return false;
  const tokens = expected.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => commandLine.includes(token));
}

async function listWorkingDirectories(): Promise<Map<number, string>> {
  if (process.platform === 'linux') return listLinuxWorkingDirectories();
  const result = await execCapture('lsof', ['-d', 'cwd', '-Fpn'], process.cwd(), 15_000);
  // lsof may return 1 when some short-lived processes disappear during its scan;
  // usable stdout is still authoritative for the remaining PIDs.
  if (!result.stdout.trim()) {
    throw new Error(`could not list process working directories: ${result.stderr.trim() || `exit ${result.code ?? -1}`}`);
  }
  return parseLsofWorkingDirectories(result.stdout);
}

async function listLinuxWorkingDirectories(): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const entries = await readdir('/proc', { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    try {
      result.set(Number(entry.name), await readlink(`/proc/${entry.name}/cwd`));
    } catch {
      // Process exited or belongs to another user while /proc was being sampled.
    }
  }));
  return result;
}
