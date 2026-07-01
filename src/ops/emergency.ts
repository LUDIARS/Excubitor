import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { Catalog, Service } from '../catalog/loader.js';
import { listListeners } from '../scanner/ports.js';
import { execCapture } from '../shared/exec.js';
import { autoFixConfig } from '../auto_fix/config.js';

export type EmergencyAction = 'kill-port' | 'claude-port-fix';

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
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
    }, 120_000);
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
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
