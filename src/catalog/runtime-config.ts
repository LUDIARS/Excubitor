/** Excubitor 固有の運用設定を、サービス所有 catalog から分離して読む。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { interpolateRoots } from './interpolate.js';

export const DEFAULT_RUNTIME_CONFIG_PATH = 'excubitor.config.yaml';

export function readRuntimeConfig(path = DEFAULT_RUNTIME_CONFIG_PATH): Record<string, unknown> {
  const absPath = resolve(process.cwd(), path);
  const parsed = load(interpolateRoots(readFileSync(absPath, 'utf8'))) ?? {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Excubitor runtime config must be a YAML object');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'services')) {
    throw new TypeError(
      'Excubitor runtime config must not contain services; each service owns excubitor.catalog.yaml',
    );
  }
  return parsed as Record<string, unknown>;
}
