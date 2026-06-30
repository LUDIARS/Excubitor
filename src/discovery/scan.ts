/**
 * 新規サービス検出。
 *
 * Ars ワークスペース直下の git リポジトリを走査し、 catalog に未登録のものを
 * 「未登録サービス候補」 として返す。 逆に catalog にあるが clone されていない
 * (= ディレクトリ欠落) サービスも missing として返す。
 *
 * ランチャーが「新しいサービスの確認」 をするための入力。 登録はまだ手動
 * (catalog/services.yaml 編集) だが、 候補に runtime / port のヒントを添える。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { safeExec } from '../shared/exec.js';
import { repoDirOf } from '../update/checker.js';
import type { Catalog } from '../catalog/loader.js';
import { arsRoot } from '../shared/roots.js';

const logger = createNamedLogger('excubitor.discovery');

// ワークスペースルートは shared/roots.ts に集約 (env EXCUBITOR_ARS_ROOT / LUDIARS_ROOT
// → cwd の親)。 後方互換のため discovery からも re-export する。
export { arsRoot };

export interface DiscoveredRepo {
  name: string;
  path: string;
  hasPackageJson: boolean;
  hasComposeFile: boolean;
  /** package.json に dev script があるか (= node runtime 候補)。 */
  hasDevScript: boolean;
  suggestedRuntime: 'node' | 'docker-compose' | 'unknown';
  remote: string | null;
}

export interface MissingService {
  code: string;
  repoDir: string;
}

export interface DiscoveryResult {
  /** catalog 未登録の repo。 */
  candidates: DiscoveredRepo[];
  /** catalog にあるが手元に無い repo。 */
  missing: MissingService[];
  scannedRoot: string;
}

/** catalog が既に「カバーしている」ディレクトリ集合 (cwd / compose 親) を作る。 */
function coveredDirs(catalog: Catalog): Set<string> {
  const set = new Set<string>();
  for (const svc of catalog.services) {
    const dir = repoDirOf(svc);
    if (dir) set.add(normalize(dir));
  }
  return set;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export async function discoverServices(catalog: Catalog): Promise<DiscoveryResult> {
  const root = arsRoot();
  const covered = coveredDirs(catalog);
  const candidates: DiscoveredRepo[] = [];

  let entries: string[] = [];
  try {
    const dirents = await readdir(root, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch (err) {
    logger.warn({ err: (err as Error).message, root }, 'failed to read ars root');
  }

  for (const name of entries) {
    const path = join(root, name);
    if (!existsSync(join(path, '.git'))) continue; // git repo のみ
    if (covered.has(normalize(path))) continue; // 既に catalog がカバー

    const hasPackageJson = existsSync(join(path, 'package.json'));
    const hasComposeFile =
      existsSync(join(path, 'docker-compose.yaml')) || existsSync(join(path, 'docker-compose.yml'));
    let hasDevScript = false;
    if (hasPackageJson) {
      try {
        const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        hasDevScript = Boolean(pkg.scripts?.['dev'] ?? pkg.scripts?.['dev:server']);
      } catch { /* ignore */ }
    }
    const remote = (await safeExec('git', ['config', '--get', 'remote.origin.url'], path))?.trim() || null;
    const suggestedRuntime: DiscoveredRepo['suggestedRuntime'] = hasComposeFile
      ? 'docker-compose'
      : hasDevScript
        ? 'node'
        : 'unknown';

    candidates.push({ name, path: path.replace(/\\/g, '/'), hasPackageJson, hasComposeFile, hasDevScript, suggestedRuntime, remote });
  }

  // catalog にあるが clone されていない repo。
  const missing: MissingService[] = [];
  for (const svc of catalog.services) {
    const dir = repoDirOf(svc);
    if (dir && !existsSync(dir)) missing.push({ code: svc.code, repoDir: dir.replace(/\\/g, '/') });
  }

  // 安定した並び。
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  logger.info({ candidates: candidates.length, missing: missing.length, root }, 'discovery scan complete');
  return { candidates, missing, scannedRoot: root };
}

// stat は将来 mtime ベースの新着判定に使う想定 (現状未使用)。
void stat;
