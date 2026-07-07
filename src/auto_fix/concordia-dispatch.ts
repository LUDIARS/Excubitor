import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { createNamedLogger } from '../shared/logger.js';
import type { Service } from '../catalog/loader.js';

const logger = createNamedLogger('excubitor.concordia_dispatch');

export interface ConcordiaDispatchInput {
  errorTaskId: string;
  service: Service;
  severity?: string;
  summary: string;
  logExcerpt?: string | null;
  source?: 'log' | 'process';
}

export interface ConcordiaDispatchResult {
  dispatched: boolean;
  reason?: string;
  status?: number;
  runId?: string;
  error?: string;
}

interface ConcordiaInvokeBody {
  call_name: string;
  args: Record<string, unknown>;
  cwd: string;
  branch: string;
  worktree: boolean;
  triggered_by: string;
  spawn: boolean;
}

export function shouldDispatchCrashToConcordia(input: ConcordiaDispatchInput): boolean {
  if (input.service.code !== 'anatomia') return false;
  const haystack = `${input.severity ?? ''}\n${input.summary}\n${input.logExcerpt ?? ''}`;
  if (input.source === 'process') return true;
  return /\[anatomia-crash\]|\b(fatal|crash|uncaught|unhandled)\b/i.test(haystack);
}

export function buildConcordiaInvokeBody(input: ConcordiaDispatchInput): ConcordiaInvokeBody {
  const targetRepo = input.service.cwd?.trim();
  if (!targetRepo) {
    throw new Error('Anatomia service has no cwd; cannot delegate fix task');
  }
  const callName = process.env.EXCUBITOR_CONCORDIA_CRASH_TEMPLATE || 'fix-bug';
  const spawn = process.env.EXCUBITOR_CONCORDIA_CRASH_SPAWN !== '0';
  const summary = input.summary.trim();
  const excerpt = (input.logExcerpt ?? '').trim();
  const description = [
    `Excubitor opened error_task ${input.errorTaskId} for an Anatomia crash.`,
    `Service: ${input.service.code} (${input.service.name})`,
    `Severity: ${input.severity ?? 'unknown'}`,
    `Source: ${input.source ?? 'log'}`,
    `Summary: ${summary}`,
  ].join('\n');
  const reproduceSteps = [
    '1. Inspect the Vg logs for [anatomia-crash] near the error_task timestamp.',
    '2. Reproduce the failing Anatomia command or web request from the surrounding logs.',
    '3. Fix the root cause in Anatomia, then run the relevant unit tests and typecheck.',
    '',
    'Log excerpt:',
    excerpt ? excerpt.slice(0, 4000) : '(no excerpt)',
  ].join('\n');

  return {
    call_name: callName,
    args: {
      target_repo: targetRepo,
      description,
      reproduce_steps: reproduceSteps,
    },
    cwd: targetRepo,
    branch: `fix/anatomia-crash-${input.errorTaskId.slice(0, 8)}`,
    worktree: true,
    triggered_by: `excubitor:error-task:${input.errorTaskId}`,
    spawn,
  };
}

export async function maybeDispatchCrashFixToConcordia(
  input: ConcordiaDispatchInput,
): Promise<ConcordiaDispatchResult> {
  if (process.env.EXCUBITOR_CONCORDIA_CRASH_WORKFLOW === '0') {
    return { dispatched: false, reason: 'disabled' };
  }
  if (!shouldDispatchCrashToConcordia(input)) {
    return { dispatched: false, reason: 'not_anatomia_crash' };
  }

  let body: ConcordiaInvokeBody;
  try {
    body = buildConcordiaInvokeBody(input);
  } catch (err) {
    const error = (err as Error).message;
    await markDispatch(input.errorTaskId, 'concordia_dispatch_failed', error);
    return { dispatched: false, reason: 'invalid_input', error };
  }

  await markDispatch(input.errorTaskId, 'concordia_dispatching', 'dispatching crash fix task to Concordia');
  const url = concordiaUrl('/v1/delegation/invoke');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolveTimeoutMs()),
    });
    const text = await res.text();
    const payload = safeJson(text) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = `Concordia dispatch failed HTTP ${res.status}: ${truncate(text, 1000)}`;
      await markDispatch(input.errorTaskId, 'concordia_dispatch_failed', detail);
      return { dispatched: false, status: res.status, error: detail };
    }
    const run = payload?.run && typeof payload.run === 'object'
      ? payload.run as Record<string, unknown>
      : null;
    const runId = typeof run?.id === 'string' ? run.id : undefined;
    await markDispatch(
      input.errorTaskId,
      'delegated_concordia',
      `Concordia ${body.call_name} delegated${runId ? ` run=${runId}` : ''}`,
      runId,
    );
    logger.info({ errorTaskId: input.errorTaskId, runId }, 'delegated crash fix to Concordia');
    return { dispatched: true, status: res.status, runId };
  } catch (err) {
    const error = (err as Error).message;
    await markDispatch(input.errorTaskId, 'concordia_dispatch_failed', error);
    logger.warn({ errorTaskId: input.errorTaskId, err: error }, 'Concordia dispatch failed');
    return { dispatched: false, error };
  }
}

async function markDispatch(
  errorTaskId: string,
  state: string,
  note: string,
  runId?: string,
): Promise<void> {
  db().run(sql`
    UPDATE error_tasks
    SET auto_fix_state = ${state},
        auto_fix_run_id = ${runId ?? null},
        note = CASE
          WHEN note IS NULL OR note = '' THEN ${note}
          ELSE note || char(10) || ${note}
        END,
        updated_at = unixepoch() * 1000
    WHERE id = ${errorTaskId}
  `);
}

function concordiaUrl(path: string): string {
  const base = process.env.EXCUBITOR_CONCORDIA_URL || 'http://127.0.0.1:11111';
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

function resolveTimeoutMs(): number {
  const raw = Number(process.env.EXCUBITOR_CONCORDIA_TIMEOUT_MS ?? '10000');
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...(truncated)`;
}
