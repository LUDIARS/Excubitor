/**
 * スキャンが自動生成するカタログ (`catalog/services.auto.yaml`) の読み書き。
 *
 * 手書きの source-of-truth (`catalog/services.yaml`) は壊さず、 自動検出した
 * サービスはこの別ファイルに隔離する。 loadCatalog がロード時に両者をマージする。
 * このモジュールは fs / yaml のみに依存し、 loader / scan へ依存しない (循環回避)。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { load, dump } from 'js-yaml';

const HEADER =
  '# 自動生成カタログ (Excubitor のスキャンが書き出す)。\n' +
  '# 手書きの services.yaml とは別管理。 手で編集してもよいが、 再スキャンで上書きされる。\n' +
  '# このファイルは gitignore 対象 (マシン毎)。\n';

/** 自動カタログのパス (env override 可、 既定 catalog/services.auto.yaml)。 */
export function autoCatalogPath(): string {
  const override = process.env.EXCUBITOR_AUTO_CATALOG_PATH;
  if (override && override.length > 0) return resolve(process.cwd(), override);
  return resolve(process.cwd(), 'catalog/services.auto.yaml');
}

/** 自動カタログの services 配列を生で読む。 未存在 / 壊れていれば空配列。 */
export function readAutoServicesRaw(): unknown[] {
  const path = autoCatalogPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = load(readFileSync(path, 'utf8')) as { services?: unknown } | null;
    return Array.isArray(parsed?.services) ? parsed!.services : [];
  } catch {
    return [];
  }
}

/** 自動カタログを書き出す (services 配列を `{ services: [...] }` として dump)。 */
export function writeAutoServices(services: unknown[]): void {
  const path = autoCatalogPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = dump({ services }, { lineWidth: 120, noRefs: true });
  writeFileSync(path, `${HEADER}\n${body}`, 'utf8');
}
