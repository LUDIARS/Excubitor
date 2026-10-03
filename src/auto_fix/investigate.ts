/**
 * Investigation runner  E「修正、E(runAutoFix) と並ぶ手動アクションのぁE��、E
 * **解析�Eみで何も修正しなぁE* タイプ、EClaude Code CLI に read-only な刁E��めE
 * 依頼して、E結果めEauto_fix_runs チE�Eブルに action_type='investigate' で
 * 書き込む、E
 *
 * 流れ:
 *   1. auto_fix_runs に行を作�E (action_type='investigate', state='running')
 *   2. claude CLI めEspawn  Eprompt は 「files を読んで原因と修正案を書け、E
 *      ただし一刁E��ァイル / git / shell 修正はするな、E
 *   3. stdout を取って解析テキストとして保孁E(stdout_tail に書き込む)
 *   4. safeguard: 走った後に git diff を確認、Eもし claude が誤って書ぁE
 *      換えてぁE��ら�E動で revert (= 解析モードであることの保険)
 *
 * error_tasks 側は state を変更しなぁE(= triage めEresolve は別のボタン)、E
 * verify_result / branch / commit_hash / pr_url は使わなぁE(NULL のまま)、E
 */
import { spawn } from 'node:child_process';
import { spawnOneShot } from '@ludiars/one-shot';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { autoFixConfig } from './config.js';

const logger = createNamedLogger('excubitor.investigate');

export interface InvestigateContext {
  errorTaskId: string;
  service: Service;
  triggeredBy: string;   // actor id (e.g. 'manual', 'user:abc')
  summary: string;
  logExcerpt: string;
}

const inFlight = new Set<string>();

export async function runInvestigation(ctx: InvestigateContext): Promise<{ runId: string; state: string }> {
  const code = ctx.service.code;
  if (inFlight.has(code)) {
    logger.warn({ code }, 'investigation already in flight for this service, skipping');
    throw new Error('investigation already in flight');
  }
  inFlight.add(code);

  const af = ctx.service.auto_fix;
  // auto_fix.enabled は「auto-fix を許可するか、Eの flag だが、E投賁E��ートとしては
  // 共有してよい (= 「触らせる気が無ぁE��ービス、Eは調査もしなぁE、E
  if (!af || !af.enabled) {
    inFlight.delete(code);
    throw new Error(`auto_fix not enabled for ${code} (= investigation gated by same flag)`);
  }

  const workingDir = af.working_dir
    ?? ctx.service.cwd
    ?? (ctx.service.compose_file ? dirname(ctx.service.compose_file) : null);
  if (!workingDir) {
    inFlight.delete(code);
    throw new Error(`no working_dir resolvable for ${code}`);
  }

  const runId = randomUUID();
  db().run(sql`
    INSERT INTO auto_fix_runs (id, error_task_id, service_code, agent, state, action_type, triggered_by, started_at)
    VALUES (${runId}, ${ctx.errorTaskId}, ${code}, 'claude-code', 'running', 'investigate', ${ctx.triggeredBy}, unixepoch() * 1000)
  `);

  try {
    const prompt = buildInvestigatePrompt(ctx);
    db().run(sql`UPDATE auto_fix_runs SET prompt = ${prompt} WHERE id = ${runId}`);

    // 保険として呼び出し前の HEAD と worktree を覚えておき、E丁E��書き換えが
    // あったら revert する、E
    const headBefore = await execCapture('git', ['rev-parse', 'HEAD'], workingDir).catch(() => null);

    const cli = await runClaudeCli(workingDir, prompt);

    // safeguard: 解析モード�EつもりぁEclaude が書き換えてぁE��ら巻き戻す、E
    await revertIfDirty(workingDir, headBefore?.stdout.trim() ?? null, runId);

    db().run(sql`
      UPDATE auto_fix_runs
      SET exit_code = ${cli.exitCode},
          stdout_tail = ${cli.stdout.slice(-8000)},
          stderr_tail = ${cli.stderr.slice(-4000)},
          state = ${cli.exitCode === 0 ? 'succeeded' : 'failed'},
          error_message = ${cli.exitCode === 0 ? null : cli.stderr.slice(-500)},
          finished_at = unixepoch() * 1000
      WHERE id = ${runId}
    `);

    return { runId, state: cli.exitCode === 0 ? 'succeeded' : 'failed' };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ code, runId, err: msg }, 'investigation failed');
    db().run(sql`
      UPDATE auto_fix_runs
      SET state = 'failed', error_message = ${msg}, finished_at = unixepoch() * 1000
      WHERE id = ${runId}
    `);
    return { runId, state: 'failed' };
  } finally {
    inFlight.delete(code);
  }
}

function buildInvestigatePrompt(ctx: InvestigateContext): string {
  const logTail = ctx.logExcerpt.slice(-Math.min(autoFixConfig.promptMaxChars - 2000, ctx.logExcerpt.length));
  return [
    `You are a READ-ONLY diagnostic agent invoked by Excubitor.`,
    `Service: ${ctx.service.code} (${ctx.service.name})`,
    `Working directory: this directory`,
    ``,
    `## Error`,
    ``,
    ctx.summary,
    ``,
    '```',
    logTail,
    '```',
    ``,
    `## Task`,
    ``,
    `Diagnose the root cause of this error. **Do NOT modify any files.** **Do NOT run git commands.** **Do NOT execute shell commands that change state.** Reading files / grep / ls is fine.`,
    ``,
    `Output a structured analysis in this exact format (Japanese for narrative, English for paths / code):`,
    ``,
    `### Root cause`,
    `(2-3 sentences identifying what is wrong)`,
    ``,
    `### Affected files`,
    `(bullet list of file paths relevant to the issue, with a brief reason for each  Euse \`code\` for paths)`,
    ``,
    `### Suggested fix`,
    `(brief description of the smallest fix; do NOT apply it. Include the proposed diff in a unified-diff fenced block if helpful.)`,
    ``,
    `### Confidence`,
    `high / medium / low  Eand why (1-2 sentences)`,
    ``,
    `Be concise. Total under 800 words.`,
  ].join('\n');
}

async function runClaudeCli(cwd: string, prompt: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const proc = spawnOneShot(autoFixConfig.claudeCli, ['-p'], {
      cwd,
      shell: false,
      windowsHide: true,
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
    }, autoFixConfig.cliTimeoutMs);

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

    try {
      proc.stdin.end(prompt);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'failed to write prompt to stdin');
    }
  });
}

async function execCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    proc.on('error', (err) => rejectP(err));
    proc.on('close', (code) => {
      if (code === 0) resolveP({ exitCode: code, stdout, stderr });
      else rejectP(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${stderr.trim().slice(-200)}`));
    });
  });
}

// claude ぁEread-only 持E��を無視して書き換えてぁE��ら、Estderr_tail に警告を
// 残す (= ユーザに「投賁E�E結果触られてぁE��す、Eと見せめE、E自勁Erevert は
// しなぁE Eユーザの作業中 commit / WIP まで巻き込んで壊すリスクがあるため、E
async function revertIfDirty(cwd: string, expectedHead: string | null, runId: string): Promise<void> {
  try {
    const status = await execCapture('git', ['status', '--porcelain'], cwd);
    const head = await execCapture('git', ['rev-parse', 'HEAD'], cwd);
    const dirty = status.stdout.trim().length > 0;
    const movedHead = expectedHead && head.stdout.trim() !== expectedHead;
    if (!dirty && !movedHead) return;
    logger.warn(
      { runId, dirty, movedHead, expectedHead, currentHead: head.stdout.trim() },
      'investigate run touched the worktree  Eread-only contract violated, not auto-reverting (user must inspect)',
    );
    const note = [
      '⚠ read-only contract violated:',
      `expected HEAD: ${expectedHead ?? '(unknown)'}`,
      `current  HEAD: ${head.stdout.trim()}`,
      dirty ? `dirty worktree:\n${status.stdout.trim().slice(0, 2000)}` : '',
    ].filter(Boolean).join('\n');
    db().run(sql`
      UPDATE auto_fix_runs
      SET stderr_tail = COALESCE(stderr_tail, '') || ${'\n\n' + note}
      WHERE id = ${runId}
    `);
  } catch (err) {
    logger.warn({ runId, err: (err as Error).message }, 'revertIfDirty check failed (ignored)');
  }
}


