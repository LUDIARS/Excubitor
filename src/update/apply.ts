/**
 * サービスのアップデート適用 (配信)。
 *
 * git pull --ff-only でリポを最新化し、 任意で依存再インストール、 起動中なら restart。
 * dirty (未コミット変更あり) なリポは安全のため pull せず中断する。
 */

import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { execCapture } from '../shared/exec.js';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { repoDirOf, checkUpdate } from './checker.js';
import { controlService } from '../control/manager.js';
import { isManaged } from '../process/manager.js';

const logger = createNamedLogger('excubitor.update.apply');

export interface ApplyStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface ApplyResult {
  code: string;
  ok: boolean;
  steps: ApplyStep[];
}

export interface ApplyOptions {
  /** package.json があれば npm install する (既定 true)。 */
  install?: boolean;
  /** 起動中なら適用後に restart する (既定 true)。 */
  restart?: boolean;
}

export async function applyUpdate(
  svc: Service,
  actor: string,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const install = opts.install ?? true;
  const restart = opts.restart ?? true;
  const steps: ApplyStep[] = [];
  const repoDir = repoDirOf(svc);

  const fail = (step: string, detail: string): ApplyResult => {
    steps.push({ step, ok: false, detail });
    audit(svc.code, actor, false, steps);
    return { code: svc.code, ok: false, steps };
  };

  if (!repoDir || !existsSync(`${repoDir}/.git`)) return fail('repo', 'no git repository');

  // 1. 先に状態確認 (branch / dirty / behind)。
  const status = await checkUpdate(svc, false);
  if (status.dirty) return fail('dirty_check', '未コミット変更があるため中断 (手動で commit/stash してください)');
  if (!status.branch) return fail('branch', 'ブランチを特定できません');

  // 2. fetch + pull --ff-only。
  const main = await updateMainBranch(repoDir, status.branch);
  steps.push({ step: 'main', ok: main.ok, detail: tail(main.stderr || main.stdout) });
  if (!main.ok) return fail('main', tail(main.stderr || main.stdout || 'main update failed'));

  const fetch = await execCapture('git', ['fetch', '--quiet', 'origin', status.branch], repoDir, 60000);
  steps.push({ step: 'fetch', ok: fetch.ok, detail: tail(fetch.stderr || fetch.stdout) });
  if (!fetch.ok) return fail('fetch', tail(fetch.stderr));

  const pull = await execCapture('git', ['merge', '--ff-only', `origin/${status.branch}`], repoDir, 60000);
  steps.push({ step: 'pull', ok: pull.ok, detail: tail(pull.stdout + pull.stderr) });
  if (!pull.ok) return fail('pull', tail(pull.stderr || 'ff-only マージ不可 (分岐あり)'));

  // 3. 依存インストール (node 系 + package.json あり)。
  if (install && existsSync(`${repoDir}/package.json`)) {
    const npm = await execCapture('npm', ['install'], repoDir, 300000, true);
    steps.push({ step: 'install', ok: npm.ok, detail: tail(npm.stderr || npm.stdout) });
    if (!npm.ok) return fail('install', tail(npm.stderr));
  }

  // 3.5. ビルド (runtime=app 等で build_command 指定があれば)。
  // ネイティブ/デスクトップ製品は git ff だけでは反映されないので exe を作り直す。
  if (svc.build_command) {
    const build = await execCapture(svc.build_command, [], svc.cwd ?? repoDir, 1_800_000, true);
    steps.push({ step: 'build', ok: build.ok, detail: tail(build.stderr || build.stdout) });
    if (!build.ok) return fail('build', tail(build.stderr));
  }

  // 4. 起動中なら restart (反映)。
  const running = isManaged(svc.code) || currentState(svc.code) === 'running';
  if (restart && running) {
    const r = await controlService(svc, 'restart', actor);
    steps.push({ step: 'restart', ok: r.ok, detail: tail(r.stdout + r.stderr) });
    if (!r.ok) return fail('restart', tail(r.stderr));
  } else {
    steps.push({ step: 'restart', ok: true, detail: running ? 'skipped (restart=false)' : '未起動のため restart 不要' });
  }

  audit(svc.code, actor, true, steps);
  logger.info({ code: svc.code, steps: steps.length }, 'update applied');
  return { code: svc.code, ok: true, steps };
}

function currentState(code: string): string | null {
  const rows = db().all(sql`
    SELECT si.state AS state FROM service_instances si
    JOIN services s ON s.id = si.service_id WHERE s.code = ${code} LIMIT 1
  `) as Array<{ state: string }>;
  return rows[0]?.state ?? null;
}

function audit(code: string, actor: string, ok: boolean, steps: ApplyStep[]): void {
  db().run(sql`
    INSERT INTO audit_log (actor, action, target_type, target_id, payload)
    VALUES (${actor}, ${'service.update'}, ${'service'}, ${code}, ${JSON.stringify({ ok, steps })})
  `);
}

async function updateMainBranch(repoDir: string, currentBranch: string) {
  const fetchMain = await execCapture('git', ['fetch', '--quiet', 'origin', 'main'], repoDir, 60000);
  if (!fetchMain.ok) return fetchMain;

  if (currentBranch === 'main') {
    return execCapture('git', ['merge', '--ff-only', 'origin/main'], repoDir, 60000);
  }

  return execCapture(
    'git',
    ['fetch', '--quiet', 'origin', 'main:refs/heads/main'],
    repoDir,
    60000,
  );
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > 800 ? '…' + t.slice(-800) : t;
}
