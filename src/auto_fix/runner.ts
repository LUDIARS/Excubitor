/**
 * Auto-fix runner  EClaude Code CLI 子�Eロセスを起動して service の cwd で
 * 修正を試みる、E完亁E��Eservice めErestart して health probe で verify する、E
 *
 * 流れ:
 *   1. auto_fix_runs に行を作�E (state=pending)
 *   2. branch 刁E�� (git switch -c <branch>)
 *   3. claude -p に prompt めEstdin で渡して spawn
 *   4. 終亁E��、Egit diff を確誁E
 *   5. git add + commit + push + (optional) gh pr create
 *   6. service めEExcubitor の控ぁEAPI 経由で restart
 *   7. health endpoint めEprobe して verify
 *   8. error_task / auto_fix_runs を更新
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { controlService } from '../control/manager.js';
import { autoFixConfig } from './config.js';

const logger = createNamedLogger('excubitor.auto_fix');

export interface AutoFixContext {
  errorTaskId: string;
  service: Service;
  triggeredBy: 'auto' | string;  // 'auto' or actor id
  summary: string;
  logExcerpt: string;
}

/**
 * 起勁E+ 直列実行ガーチE(同一 service に対して同時に 1 つだぁE、E
 */
const inFlight = new Set<string>();

export async function runAutoFix(ctx: AutoFixContext): Promise<{ runId: string; state: string }> {
  const code = ctx.service.code;
  if (inFlight.has(code)) {
    logger.warn({ code }, 'auto-fix already in flight for this service, skipping');
    throw new Error('auto-fix already in flight');
  }
  inFlight.add(code);

  const af = ctx.service.auto_fix;
  if (!af || !af.enabled) {
    inFlight.delete(code);
    throw new Error(`auto_fix not enabled for ${code}`);
  }

  const workingDir = af.working_dir
    ?? ctx.service.cwd
    ?? (ctx.service.compose_file ? dirname(ctx.service.compose_file) : null);
  if (!workingDir) {
    inFlight.delete(code);
    throw new Error(`no working_dir resolvable for ${code}`);
  }

  // run row 作�E、Eaction_type='fix' を�E示  EDB のチE��ォルト値と一致するが、E
  // investigate と並ぶ系統であることめESQL 上で明確にする、E
  const runId = randomUUID();
  db().run(sql`
    INSERT INTO auto_fix_runs (id, error_task_id, service_code, agent, state, action_type, triggered_by, started_at)
    VALUES (${runId}, ${ctx.errorTaskId}, ${code}, 'claude-code', 'running', 'fix', ${ctx.triggeredBy}, unixepoch() * 1000)
  `);
  await markError(ctx.errorTaskId, 'running', runId);

  try {
    const branch = `${af.branch_prefix}${runId.slice(0, 8)}`;
    const prompt = buildPrompt(ctx, branch, af);

    db().run(sql`UPDATE auto_fix_runs SET branch = ${branch}, prompt = ${prompt} WHERE id = ${runId}`);

    // 1) branch 刁E�� (失敗しても続衁E Eclaude 側に任せる選択もあり)
    await execCapture('git', ['switch', '-c', branch], workingDir).catch(() => {
      logger.warn({ code, branch }, 'git switch failed (maybe branch already exists), continuing');
    });

    // 2) Claude Code CLI 起勁E
    const cli = await runClaudeCli(workingDir, prompt);
    db().run(sql`
      UPDATE auto_fix_runs
      SET exit_code = ${cli.exitCode},
          stdout_tail = ${cli.stdout.slice(-4000)},
          stderr_tail = ${cli.stderr.slice(-4000)},
          state = 'fixed'
      WHERE id = ${runId}
    `);

    if (cli.exitCode !== 0) {
      throw new Error(`claude CLI exit ${cli.exitCode}: ${cli.stderr.slice(-500)}`);
    }

    // 2.5) safeguard  Ebranch に「危険なファイル」が含まれてぁE��ぁE��検査、E
    //      .env / *.bak / *.pem / *.key 等�E secret-risk file は push を許可せず人間判断へ、E
    const allChanged = await collectChangedFiles(workingDir);
    const unsafe = pickUnsafeFiles(allChanged);
    if (unsafe.length > 0) {
      const reason = `unsafe files in branch (refuse push, escalating to human): ${unsafe.slice(0, 10).join(', ')}`;
      logger.warn({ code, runId, unsafe }, reason);
      db().run(sql`
        UPDATE auto_fix_runs
        SET state = 'failed', error_message = ${reason}, finished_at = unixepoch() * 1000
        WHERE id = ${runId}
      `);
      db().run(sql`
        UPDATE error_tasks
        SET auto_fix_state = 'awaiting_human', auto_fix_run_id = ${runId}, updated_at = unixepoch() * 1000
        WHERE id = ${ctx.errorTaskId}
      `);
      return { runId, state: 'failed' };
    }

    // 3) diff 確誁E+ commit + push + PR (claude が既にめE��てる場合もあるが、E補完で実施)
    const diff = await execCapture('git', ['status', '--porcelain'], workingDir);
    if (diff.stdout.trim().length === 0) {
      // claude ぁEcommit してぁE�� working tree がきれいなら、E既に push 済みか確誁E
      const lastCommit = await execCapture('git', ['log', '-1', '--pretty=%H'], workingDir);
      db().run(sql`
        UPDATE auto_fix_runs SET commit_hash = ${lastCommit.stdout.trim()} WHERE id = ${runId}
      `);
    } else {
      await execCapture('git', ['add', '-A'], workingDir);
      const commit = await execCapture(
        'git',
        ['commit', '-m', `auto-fix(${code}): ${ctx.summary.slice(0, 60)}\n\nrun-id: ${runId}`],
        workingDir,
      );
      logger.info({ code, runId, stdout: commit.stdout.slice(-200) }, 'auto-fix committed');
      const hash = await execCapture('git', ['rev-parse', 'HEAD'], workingDir);
      db().run(sql`UPDATE auto_fix_runs SET commit_hash = ${hash.stdout.trim()} WHERE id = ${runId}`);
    }

    // push (失敗してめEverify は続衁E
    let prUrl: string | null = null;
    try {
      await execCapture('git', ['push', '-u', 'origin', branch], workingDir);
      if (af.create_pr) {
        const prArgs = [
          'pr', 'create',
          af.pr_draft ? '--draft' : '--fill',
          '--title', `auto-fix(${code}): ${ctx.summary.slice(0, 60)}`,
          '--body', `Auto-generated by Excubitor.\n\nerror_task_id: ${ctx.errorTaskId}\nrun_id: ${runId}\n\n## Error\n\n\`\`\`\n${ctx.logExcerpt.slice(0, 4000)}\n\`\`\``,
        ];
        const pr = await execCapture('gh', prArgs, workingDir);
        prUrl = pr.stdout.trim().split('\n').find((l) => l.startsWith('http')) ?? null;
        if (prUrl) {
          db().run(sql`UPDATE auto_fix_runs SET pr_url = ${prUrl} WHERE id = ${runId}`);
        }
      }
    } catch (err) {
      logger.warn({ code, err: (err as Error).message }, 'push or gh pr create failed');
    }

    // 4) verify: service restart + health probe
    db().run(sql`UPDATE auto_fix_runs SET state = 'verifying' WHERE id = ${runId}`);
    const verify = await verifyService(ctx.service);
    db().run(sql`
      UPDATE auto_fix_runs
      SET state = ${verify === 'ok' ? 'succeeded' : 'failed'},
          verify_result = ${verify},
          finished_at = unixepoch() * 1000
      WHERE id = ${runId}
    `);
    await markError(ctx.errorTaskId, verify === 'ok' ? 'succeeded' : 'failed', runId);

    if (verify === 'ok') {
      db().run(sql`
        UPDATE error_tasks SET state = 'resolved', triaged_by = ${'auto-fix:' + runId}, triaged_at = unixepoch() * 1000
        WHERE id = ${ctx.errorTaskId}
      `);
    }

    return { runId, state: verify === 'ok' ? 'succeeded' : 'failed' };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ code, runId, err: msg }, 'auto-fix failed');
    db().run(sql`
      UPDATE auto_fix_runs
      SET state = 'failed', error_message = ${msg}, finished_at = unixepoch() * 1000
      WHERE id = ${runId}
    `);
    await markError(ctx.errorTaskId, 'failed', runId);
    return { runId, state: 'failed' };
  } finally {
    inFlight.delete(code);
  }
}

function buildPrompt(ctx: AutoFixContext, branch: string, af: NonNullable<Service['auto_fix']>): string {
  const logTail = ctx.logExcerpt.slice(-Math.min(autoFixConfig.promptMaxChars - 2000, ctx.logExcerpt.length));
  const extra = af.prompt_extra ? `\n\nAdditional guidance:\n${af.prompt_extra}` : '';
  return [
    `You are an automated repair agent invoked by Excubitor.`,
    `Service: ${ctx.service.code} (${ctx.service.name})`,
    `Working directory: this directory`,
    `Branch already switched to: ${branch}`,
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
    `1. Diagnose the root cause from the log.`,
    `2. Apply the SMALLEST possible fix in this directory (do not refactor beyond what is needed).`,
    `3. Commit the change with a clear message.`,
    `4. Push to origin and${af.create_pr ? ` open a${af.pr_draft ? ' draft' : ''} PR with title "auto-fix(${ctx.service.code}): <summary>".` : ' do NOT open a PR.'}`,
    `5. Print a short summary of what you changed and why.`,
    ``,
    `## Hard rules (must obey strictly)`,
    ``,
    `- Make the SMALLEST possible diff. Touch only files directly required to fix the error.`,
    `- DO NOT create backup files. Forbidden patterns (case-insensitive): \`*.bak\`, \`*.bak.*\`, \`*.orig\`, \`*.before-*\`, \`*.backup\`, \`*~\`.`,
    `- DO NOT touch \`.env\`, \`.env.*\`, or any file containing secrets, tokens, passwords, OAuth client secrets, API keys, certificates, or private keys (\`*.pem\`, \`*.key\`, \`*.p12\`).`,
    `- DO NOT include secret values in any commit. GitHub secret-scanning will block the push and the fix will fail.`,
    `- If you have already created any such file in this branch, REMOVE it with \`git rm\` and \`rm\` before committing.`,
    `- If the only viable fix requires editing \`.env\` or committing secrets, STOP. Do not commit. Print "REQUIRES_HUMAN: <reason>" and exit non-zero so a human can take over.`,
    `Do NOT delete or rewrite unrelated files. Stay strictly within the scope of fixing the reported error.${extra}`,
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

// branch に含まれる変更ファイル (未 commit + commit 済み) を集める
async function collectChangedFiles(cwd: string): Promise<string[]> {
  const out = new Set<string>();
  // 未 commit (staged / unstaged / untracked)
  try {
    const r = await execCapture('git', ['status', '--porcelain'], cwd);
    for (const line of r.stdout.split(/\r?\n/)) {
      const path = line.slice(3).trim();
      if (path) out.add(path);
    }
  } catch { /* noop */ }
  // 現 branch と main の diff (commit 済みの変更)
  for (const base of ['main', 'master']) {
    try {
      const r = await execCapture('git', ['diff', '--name-only', `${base}...HEAD`], cwd);
      for (const f of r.stdout.split(/\r?\n/)) {
        const t = f.trim();
        if (t) out.add(t);
      }
      break;
    } catch { /* try next base */ }
  }
  return Array.from(out);
}

const UNSAFE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,                  // .env, .env.local, .env.production etc.
  /\.bak(\..*)?$/i,                        // .bak, .bak.something
  /\.orig$/i,
  /\.backup$/i,
  /\.before-.+/i,                          // .env.bak.before-smoke 筁E
  /(^|\/)[^/]+~$/,                         // editor backups
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /(^|\/)credentials?(\.json|\.yaml|\.yml)?$/i,
  /(^|\/)secrets?(\.json|\.yaml|\.yml)?$/i,
];

function pickUnsafeFiles(files: string[]): string[] {
  return files.filter((f) => UNSAFE_PATTERNS.some((re) => re.test(f)));
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

async function verifyService(svc: Service): Promise<'ok' | 'health_failed' | 'still_crashing' | 'not_attempted'> {
  try {
    await controlService(svc, 'restart', 'auto-fix');
  } catch (err) {
    logger.warn({ code: svc.code, err: (err as Error).message }, 'verify restart failed');
    return 'still_crashing';
  }

  const url = svc.health?.url;
  if (!url) return 'not_attempted';
  const deadline = Date.now() + autoFixConfig.verifyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return 'ok';
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return 'health_failed';
}

async function markError(taskId: string, state: string, runId: string | null): Promise<void> {
  db().run(sql`
    UPDATE error_tasks
    SET auto_fix_state = ${state},
        auto_fix_run_id = ${runId},
        updated_at = unixepoch() * 1000
    WHERE id = ${taskId}
  `);
}


