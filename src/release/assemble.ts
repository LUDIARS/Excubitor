/**
 * 1 component をバンドルへ組み込む: include パスをコピーし、 必要なら staged コピー側で
 * `npm ci --omit=dev` を走らせて prod node_modules を生成する。
 *
 * fs は node:fs を直接使うが、 prod install の runner は注入できる (テストで fake)。
 */

import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StepRunner } from './steps.js';
import type { ResolvedComponent } from './plan.js';

export interface AssembleResult {
  code: string;
  bundleSubdir: string;
  /** コピーできた include パス。 */
  copied: string[];
  /** repo に存在せずスキップした include パス。 */
  missing: string[];
  /** prod install の結果 (prod_install=false なら null)。 */
  prodInstall: { ran: boolean; ok: boolean; stderr: string } | null;
}

const PROD_INSTALL_CMD = 'npm ci --omit=dev --no-audit --no-fund';

export async function assembleComponent(
  rc: ResolvedComponent,
  bundleRoot: string,
  run: StepRunner,
): Promise<AssembleResult> {
  const destDir = join(bundleRoot, rc.bundleSubdir);
  mkdirSync(destDir, { recursive: true });

  const copied: string[] = [];
  const missing: string[] = [];
  for (const rel of rc.component.include) {
    const src = join(rc.repoDir, rel);
    if (!existsSync(src)) {
      missing.push(rel);
      continue;
    }
    cpSync(src, join(destDir, rel), { recursive: true });
    copied.push(rel);
  }

  let prodInstall: AssembleResult['prodInstall'] = null;
  if (rc.component.prod_install) {
    const r = await run(PROD_INSTALL_CMD, destDir);
    prodInstall = { ran: true, ok: r.ok, stderr: r.ok ? '' : r.stderr.slice(-2000) };
  }

  return { code: rc.component.code, bundleSubdir: rc.bundleSubdir, copied, missing, prodInstall };
}
