/**
 * Infisical secret 一覧から catalog の include / exclude / prefix を適用して env オブジェクトを作る。
 */
import { minimatch } from './minimatch.js';

export interface InjectSpec {
  prefix?: string;
  include?: string[];
  exclude?: string[];
}

export function applyInjectFilter(
  secrets: Record<string, string>,
  spec: InjectSpec,
): Record<string, string> {
  const out: Record<string, string> = {};
  const include = spec.include ?? null;
  const exclude = spec.exclude ?? [];

  for (const [key, value] of Object.entries(secrets)) {
    if (include && !include.some((p) => minimatch(key, p))) continue;
    if (exclude.some((p) => minimatch(key, p))) continue;
    const finalKey = (spec.prefix ?? '') + key;
    out[finalKey] = value;
  }
  return out;
}
