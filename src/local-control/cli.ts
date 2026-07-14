#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { requestLocalControl } from './client.js';
import { ensureLocalControlSupervisor } from './ensure-supervisor.js';
import type { LocalControlAction, LocalControlResponse, LocalControlTarget } from './protocol.js';

const ACTIONS = new Set<LocalControlAction>([
  'start',
  'stop',
  'restart',
  'status',
  'kill-port',
  'claude-port-fix',
]);

export async function runExcubitorCtl(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const portArgument = argv.find((argument) => argument.startsWith('--port='));
  const port = portArgument ? Number(portArgument.slice('--port='.length)) : undefined;
  if (portArgument && (!Number.isInteger(port) || port! < 1 || port! > 65_535)) {
    process.stderr.write('excubitorctl: --port must be an integer from 1 to 65535\n');
    return 2;
  }
  const positional = argv.filter((argument) => argument !== '--json' && argument !== portArgument);
  const parsed = parseCommand(positional);
  if (!parsed) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  try {
    if (shouldEnsureSupervisor(parsed.target, parsed.action)) {
      await ensureLocalControlSupervisor();
    }
    const response = await requestLocalControl({
      target: parsed.target,
      action: parsed.action,
      actor: 'excubitorctl',
      ...(port !== undefined ? { parameters: { port } } : {}),
    });
    process.stdout.write(json ? `${JSON.stringify(response)}\n` : `${renderResponse(response)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'CLIENT_ERROR', message } })}\n`);
    } else {
      process.stderr.write(`excubitorctl: ${message}\n`);
    }
    return 1;
  }
}

function shouldEnsureSupervisor(target: LocalControlTarget, action: LocalControlAction): boolean {
  if (action === 'status') return false;
  if (target.kind === 'excubitor' && action === 'stop') return false;
  return true;
}

function parseCommand(argv: string[]): { target: LocalControlTarget; action: LocalControlAction } | null {
  const scope = argv[0];
  if (scope === 'service' && argv.length === 3) {
    const code = argv[1];
    const action = parseAction(argv[2]);
    if (code && action) return { target: { kind: 'service', code }, action };
  }
  if (scope === 'excubitor' && argv.length === 2) {
    const action = parseAction(argv[1]);
    if (action) return { target: { kind: 'excubitor' }, action };
  }
  return null;
}

function parseAction(value: string | undefined): LocalControlAction | null {
  return value && ACTIONS.has(value as LocalControlAction) ? value as LocalControlAction : null;
}

function renderResponse(response: LocalControlResponse): string {
  if (response.payload?.kind === 'control-result') {
    const result = response.payload.value;
    const output = result.ok ? result.stdout || 'ok' : result.stderr || 'control failed';
    const truncated = result.stdout_truncated || result.stderr_truncated || result.command_truncated;
    return truncated ? `${output}\n[local-control output truncated]` : output;
  }
  if (response.payload?.kind === 'service-status') {
    const pid = response.payload.pid ? ` pid=${response.payload.pid}` : '';
    return `${response.payload.code}: ${response.payload.state}${pid}`;
  }
  if (response.payload?.kind === 'excubitor-status') {
    const pid = response.payload.pid ? ` pid=${response.payload.pid}` : '';
    return `excubitor: ${response.payload.state}${pid}`;
  }
  if (response.payload?.kind === 'emergency-result') {
    const result = response.payload.value;
    const output = result.ok ? result.stdout || 'ok' : result.stderr || 'emergency action failed';
    const truncated = result.stdout_truncated || result.stderr_truncated || result.prompt_truncated;
    return truncated ? `${output}\n[local-control output truncated]` : output;
  }
  if (response.payload?.kind === 'accepted') {
    return `${response.operation_id}: accepted (${response.payload.target_key})`;
  }
  return response.error?.message ?? `${response.operation_id}: ${response.state}`;
}

function usage(): string {
  return [
    'Usage:',
    '  excubitorctl service <code> <start|stop|restart|status|kill-port|claude-port-fix> [--port=<n>] [--json]',
    '  excubitorctl excubitor <start|stop|restart|status> [--json]',
  ].join('\n');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void runExcubitorCtl(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
