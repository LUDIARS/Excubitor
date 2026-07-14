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
  '# Auto-generated catalog written by Excubitor scan.\n' +
  '# Manual edits are allowed, but scan may update services.\n' +
  '# Add codes to ignored_codes to keep them out of future scans.\n';

export interface AutoCatalogRaw {
  services: unknown[];
  ignored_codes: string[];
}

/** 自動カタログのパス (env override 可、 既定 catalog/services.auto.yaml)。 */
export function autoCatalogPath(): string {
  const override = process.env.EXCUBITOR_AUTO_CATALOG_PATH;
  if (override && override.length > 0) return resolve(process.cwd(), override);
  return resolve(process.cwd(), 'catalog/services.auto.yaml');
}

export function readAutoCatalogRaw(): AutoCatalogRaw {
  const path = autoCatalogPath();
  if (!existsSync(path)) return { services: [], ignored_codes: [] };
  try {
    const parsed = load(readFileSync(path, 'utf8')) as { services?: unknown; ignored_codes?: unknown } | null;
    const services = Array.isArray(parsed?.services) ? parsed!.services : [];
    const ignored_codes = Array.isArray(parsed?.ignored_codes)
      ? parsed!.ignored_codes.filter((code): code is string => typeof code === 'string' && code.length > 0)
      : [];
    return { services, ignored_codes };
  } catch {
    return { services: [], ignored_codes: [] };
  }
}

/** 自動カタログの services 配列を生で読む。 未存在 / 壊れていれば空配列。 */
export function readAutoServicesRaw(): unknown[] {
  return readAutoCatalogRaw().services;
}

/** 自動カタログを書き出す (services 配列を `{ services: [...] }` として dump)。 */
export function writeAutoServices(services: unknown[], ignored_codes = readAutoCatalogRaw().ignored_codes): void {
  const path = autoCatalogPath();
  mkdirSync(dirname(path), { recursive: true });
  const document = ignored_codes.length > 0 ? { ignored_codes, services } : { services };
  const body = dump(document, { lineWidth: 120, noRefs: true });
  writeFileSync(path, `${HEADER}\n${body}`, 'utf8');
}
