import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import type { Catalog, Service } from '../catalog/loader.js';
import { listListeners } from '../scanner/ports.js';
import { execCapture } from '../shared/exec.js';
import { autoFixConfig } from '../auto_fix/config.js';
import { managedPortsForService } from '../catalog/ports.js';

export type EmergencyAction = 'kill-port' | 'claude-port-fix';
const MAX_CLI_OUTPUT_CHARS = 64 * 1024;

export interface EmergencyResult {
  ok: boolean;
  action: EmergencyAction;
  code: string;
  port: number | null;
  pids: number[];
  stdout: string;
  stderr: string;
  prompt?: string;
}

export async function runEmergencyAction(
  catalog: Catalog,
  svc: Service,
  action: EmergencyAction,
  extraPrompt?: string,
  portOverride?: number,
): Promise<EmergencyResult> {
  if (action === 'kill-port') return killServicePort(svc, portOverride);
  return runClaudePortFix(catalog, svc, extraPrompt);
}

async function killServicePort(svc: Service, portOverride?: number): Promise<EmergencyResult> {
  const targetPort = portOverride ?? svc.port;
  if (typeof targetPort !== 'number') {
    return { ok: false, action: 'kill-port', code: svc.code, port: null, pids: [], stdout: '', stderr: 'service has no port' };
  }
  const declaredPorts = new Set(managedPortsForService(svc).map((entry) => entry.port));
  if (!declaredPorts.has(targetPort)) {
    return {
      ok: false,
      action: 'kill-port',
      code: svc.code,
      port: targetPort,
      pids: [],
      stdout: '',
      stderr: `port ${targetPort} is not declared for service ${svc.code}`,
    };
  }
  const listener = (await listListeners()).find((l) => l.port === targetPort);
  const pids = listener?.pids ?? [];
  if (pids.length === 0) {
    return { ok: true, action: 'kill-port', code: svc.code, port: targetPort, pids: [], stdout: 'no listener found', stderr: '' };
  }

  const outputs: string[] = [];
  const errors: string[] = [];
  for (const pid of pids) {
    const result = process.platform === 'win32'
      ? await execCapture('taskkill', ['/PID', String(pid), '/T', '/F'], process.cwd(), 15000)
      : await execCapture('kill', ['-TERM', String(pid)], process.cwd(), 15000);
    outputs.push(result.stdout.trim());
    if (!result.ok || result.stderr.trim()) errors.push(`pid ${pid}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }

  return {
    ok: errors.length === 0,
    action: 'kill-port',
    code: svc.code,
    port: targetPort,
    pids,
    stdout: outputs.filter(Boolean).join('\n') || `killed ${pids.length} process(es)`,
    stderr: errors.join('\n'),
  };
}

async function runClaudePortFix(catalog: Catalog, svc: Service, extraPrompt?: string): Promise<EmergencyResult> {
  const prompt = buildPortFixPrompt(catalog, svc, extraPrompt);
  const cwd = svc.cwd ?? (svc.compose_file ? dirname(svc.compose_file) : process.cwd());
  const cli = await runClaudeCli(cwd, prompt);
  return {
    ok: cli.exitCode === 0,
    action: 'claude-port-fix',
    code: svc.code,
    port: svc.port ?? null,
    pids: [],
    stdout: cli.stdout,
    stderr: cli.stderr || (cli.exitCode === 0 ? '' : `claude exited ${cli.exitCode}`),
    prompt,
  };
}

function buildPortFixPrompt(catalog: Catalog, svc: Service, extraPrompt?: string): string {
  const siblings = catalog.services
    .filter((s) => (s.project_code ?? s.code) === (svc.project_code ?? svc.code))
    .map((s) => `${s.component ?? 'service'} ${s.code} port=${s.port ?? '-'} runtime=${s.runtime}`)
    .join('\n');
  return [
    'You are an operations assistant invoked by Excubitor for a local emergency workaround.',
    'Goal: unblock local development by stopping only the process that is incorrectly occupying the target service port.',
    '',
    `Target service: ${svc.code} (${svc.name})`,
    `Target project: ${svc.project_code ?? svc.code}`,
    `Target component: ${svc.component ?? '-'}`,
    `Target port: ${svc.port ?? '-'}`,
    '',
    'Project services:',
    siblings || '- none',
    '',
    'Rules:',
    '- You may inspect local processes and ports.',
    '- You may kill only processes that are listening on the target port or clearly belong to the target service.',
    '- Do not edit files, run git commands, install packages, or kill unrelated infrastructure processes.',
    '- Print the commands you ran and the final result.',
    extraPrompt ? `\nOperator note:\n${extraPrompt}` : '',
  ].join('\n');
}

async function runClaudeCli(cwd: string, prompt: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const proc = spawn(autoFixConfig.claudeCli, ['-p'], {
      cwd,
      shell: true,
      env: {
        ...process.env,
        CLAUDE_CODE_GIT_BASH_PATH: autoFixConfig.claudeBashPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      void terminateClaudeProcessTree(proc).catch((error: unknown) => {
        stderr = appendBounded(stderr, `\ntermination failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 120_000);
    proc.stdout.on('data', (c: Buffer) => { stdout = appendBounded(stdout, c.toString('utf8')); });
    proc.stderr.on('data', (c: Buffer) => { stderr = appendBounded(stderr, c.toString('utf8')); });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolveP({ exitCode: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolveP({ exitCode: code ?? -1, stdout, stderr });
    });
    proc.stdin.end(prompt);
  });
}

async function terminateClaudeProcessTree(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    const result = await execCapture('taskkill', ['/PID', String(proc.pid), '/T', '/F'], process.cwd(), 10_000);
    if (!result.ok && proc.exitCode === null && proc.signalCode === null) {
      throw new Error(result.stderr || `taskkill exited ${result.code}`);
    }
    return;
  }
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { return; }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_CLI_OUTPUT_CHARS
    ? combined
    : combined.slice(-MAX_CLI_OUTPUT_CHARS);
}
