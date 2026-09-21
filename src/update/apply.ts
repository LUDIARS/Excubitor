/**
 * サービスのアップデート適用 (配信)。
 *
 * git pull --ff-only でリポを最新化し、 任意で依存再インストール、 起動中なら restart。
 * dirty (未コミット変更あり) なリポは安全のため pull せず中断する。
 * 個々の手順は steps.ts (拠点への依頼 federation/operations と共用)。
 */

import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { controlServiceViaLocalTool } from '../local-control/service-adapter.js';
import { isManaged } from '../process/manager.js';
import { currentState } from './service-state.js';
import {
  buildService,
  checkRepoReady,
  fastForwardFromOrigin,
  installDependencies,
  tail,
  type StepResult,
} from './steps.js';

const logger = createNamedLogger('excubitor.update.apply');

export type ApplyStep = StepResult;

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

  const finish = (ok: boolean): ApplyResult => {
    audit(svc.code, actor, ok, steps);
    if (ok) logger.info({ code: svc.code, steps: steps.length }, 'update applied');
    return { code: svc.code, ok, steps };
  };

  // 1. 先に状態確認 (repo / dirty / branch)。
  const { ready, step } = await checkRepoReady(svc);
  if (!ready) {
    steps.push(step!);
    return finish(false);
  }

  // 2. main と今の branch を origin から fast-forward。
  for (const s of await fastForwardFromOrigin(ready.repoDir, ready.branch)) {
    steps.push(s);
    if (!s.ok) return finish(false);
  }

  // 3. 依存インストール (node 系 + package.json あり)。
  if (install) {
    const npm = await installDependencies(ready.repoDir);
    if (npm) {
      steps.push(npm);
      if (!npm.ok) return finish(false);
    }
  }

  // 3.5. ビルド (runtime=app 等で build_command 指定があれば)。
  // ネイティブ/デスクトップ製品は git ff だけでは反映されないので exe を作り直す。
  const build = await buildService(svc, ready.repoDir, 'catalog');
  if (build) {
    steps.push(build);
    if (!build.ok) return finish(false);
  }

  // 4. 起動中なら restart (反映)。
  const running = isManaged(svc.code) || currentState(svc.code) === 'running';
  if (restart && running) {
    const r = await controlServiceViaLocalTool(svc, 'restart', actor);
    steps.push({ step: 'restart', ok: r.ok, detail: tail(r.stdout + r.stderr) });
    if (!r.ok) return finish(false);
  } else {
    steps.push({ step: 'restart', ok: true, detail: running ? 'skipped (restart=false)' : '未起動のため restart 不要' });
  }
  return finish(true);
}

function audit(code: string, actor: string, ok: boolean, steps: ApplyStep[]): void {
  db().run(sql`
    INSERT INTO audit_log (actor, action, target_type, target_id, payload)
    VALUES (${actor}, ${'service.update'}, ${'service'}, ${code}, ${JSON.stringify({ ok, steps })})
  `);
}
