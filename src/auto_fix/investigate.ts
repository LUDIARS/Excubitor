/**
 * Investigation runner — 「修正」 (runAutoFix) と並ぶ手動アクションのうち、
 * **解析のみで何も修正しない** タイプ。 Claude Code CLI に read-only な分析を
 * 依頼して、 結果を auto_fix_runs テーブルに action_type='investigate' で
 * 書き込む。
 *
 * 流れ:
 *   1. auto_fix_runs に行を作成 (action_type='investigate', state='running')
 *   2. claude CLI を spawn — prompt は 「files を読んで原因と修正案を書け、
 *      ただし一切ファイル / git / shell 修正はするな」
 *   3. stdout を取って解析テキストとして保存 (stdout_tail に書き込む)
 *   4. safeguard: 走った後に git diff を確認、 もし claude が誤って書き
 *      換えていたら自動で revert (= 解析モードであることの保険)
 *
 * error_tasks 側は state を変更しない (= triage や resolve は別のボタン)。
 * verify_result / branch / commit_hash / pr_url は使わない (NULL のまま)。
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { autoFixConfig } from './config.js';

const logger = pino({ name: 'excubitor.investigate' });

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
  // auto_fix.enabled は「auto-fix を許可するか」 の flag だが、 投資ゲートとしては
  // 共有してよい (= 「触らせる気が無いサービス」 は調査もしない)。
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

  const rows = await db.execute(sql`
    INSERT INTO auto_fix_runs (error_task_id, service_code, agent, state, action_type, triggered_by, started_at)
    VALUES (${ctx.errorTaskId}::uuid, ${code}, 'claude-code', 'running', 'investigate', ${ctx.triggeredBy}, now())
    RETURNING id
  `);
  const runId = (rows as unknown as Array<{ id: string }>)[0]!.id;

  try {
    const prompt = buildInvestigatePrompt(ctx);
    await db.execute(sql`UPDATE auto_fix_runs SET prompt = ${prompt} WHERE id = ${runId}::uuid`);

    // 保険として呼び出し前の HEAD と worktree を覚えておき、 万一書き換えが
    // あったら revert する。
    const headBefore = await execCapture('git', ['rev-parse', 'HEAD'], workingDir).catch(() => null);

    const cli = await runClaudeCli(workingDir, prompt);

    // safeguard: 解析モードのつもりが claude が書き換えていたら巻き戻す。
    await revertIfDirty(workingDir, headBefore?.stdout.trim() ?? null, runId);

    await db.execute(sql`
      UPDATE auto_fix_runs
      SET exit_code = ${cli.exitCode},
          stdout_tail = ${cli.stdout.slice(-8000)},
          stderr_tail = ${cli.stderr.slice(-4000)},
          state = ${cli.exitCode === 0 ? 'succeeded' : 'failed'},
          error_message = ${cli.exitCode === 0 ? null : cli.stderr.slice(-500)},
          finished_at = now()
      WHERE id = ${runId}::uuid
    `);

    return { runId, state: cli.exitCode === 0 ? 'succeeded' : 'failed' };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ code, runId, err: msg }, 'investigation failed');
    await db.execute(sql`
      UPDATE auto_fix_runs
      SET state = 'failed', error_message = ${msg}, finished_at = now()
      WHERE id = ${runId}::uuid
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
    `(bullet list of file paths relevant to the issue, with a brief reason for each — use \`code\` for paths)`,
    ``,
    `### Suggested fix`,
    `(brief description of the smallest fix; do NOT apply it. Include the proposed diff in a unified-diff fenced block if helpful.)`,
    ``,
    `### Confidence`,
    `high / medium / low — and why (1-2 sentences)`,
    ``,
    `Be concise. Total under 800 words.`,
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
    const proc = spawn(cmd, args, { cwd, shell: false });
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

// claude が read-only 指示を無視して書き換えていたら、 stderr_tail に警告を
// 残す (= ユーザに「投資の結果触られています」 と見せる)。 自動 revert は
// しない — ユーザの作業中 commit / WIP まで巻き込んで壊すリスクがあるため。
async function revertIfDirty(cwd: string, expectedHead: string | null, runId: string): Promise<void> {
  try {
    const status = await execCapture('git', ['status', '--porcelain'], cwd);
    const head = await execCapture('git', ['rev-parse', 'HEAD'], cwd);
    const dirty = status.stdout.trim().length > 0;
    const movedHead = expectedHead && head.stdout.trim() !== expectedHead;
    if (!dirty && !movedHead) return;
    logger.warn(
      { runId, dirty, movedHead, expectedHead, currentHead: head.stdout.trim() },
      'investigate run touched the worktree — read-only contract violated, not auto-reverting (user must inspect)',
    );
    const note = [
      '⚠ read-only contract violated:',
      `expected HEAD: ${expectedHead ?? '(unknown)'}`,
      `current  HEAD: ${head.stdout.trim()}`,
      dirty ? `dirty worktree:\n${status.stdout.trim().slice(0, 2000)}` : '',
    ].filter(Boolean).join('\n');
    await db.execute(sql`
      UPDATE auto_fix_runs
      SET stderr_tail = COALESCE(stderr_tail, '') || ${'\n\n' + note}
      WHERE id = ${runId}::uuid
    `);
  } catch (err) {
    logger.warn({ runId, err: (err as Error).message }, 'revertIfDirty check failed (ignored)');
  }
}
