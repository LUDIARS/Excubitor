/**
 * Ex backend の readiness timeout を解決する。
 *
 * 規則は domain root と同じ「env 優先 → config store → 既定」。整数でない値・範囲外の値は
 * 丸めずに無視して次の source へ進み、無視した事実を `ignored` で呼び出し側 (supervisor の
 * ログ) へ返す。
 *
 * @implements SPEC-EX-BACKEND-READINESS
 */

import { getBackendReadinessTimeoutOverride } from '../secrets/config-store.js';

export const BACKEND_READINESS_TIMEOUT_ENV = 'EXCUBITOR_BACKEND_READINESS_TIMEOUT_MS';
export const DEFAULT_BACKEND_READINESS_TIMEOUT_MS = 90_000;
export const MIN_BACKEND_READINESS_TIMEOUT_MS = 10_000;
export const MAX_BACKEND_READINESS_TIMEOUT_MS = 600_000;

export type BackendReadinessTimeoutSource = 'env' | 'config' | 'default';

export interface IgnoredBackendReadinessTimeout {
  source: Exclude<BackendReadinessTimeoutSource, 'default'>;
  detail: string;
}

export interface BackendReadinessTimeoutResolution {
  value: number;
  source: BackendReadinessTimeoutSource;
  ignored: IgnoredBackendReadinessTimeout[];
}

export interface BackendReadinessTimeoutInput {
  /** env `EXCUBITOR_BACKEND_READINESS_TIMEOUT_MS` の生値。 */
  env: string | undefined;
  /** config store に保存された値 (未設定は null / undefined)。 */
  configured: unknown;
}

export function resolveBackendReadinessTimeout(input: BackendReadinessTimeoutInput): BackendReadinessTimeoutResolution {
  const ignored: IgnoredBackendReadinessTimeout[] = [];
  const envRaw = input.env?.trim() ?? '';
  if (envRaw) {
    const value = parseBackendReadinessTimeoutMs(envRaw);
    if (value !== null) return { value, source: 'env', ignored };
    ignored.push({ source: 'env', detail: invalidDetail(envRaw) });
  }
  if (input.configured !== null && input.configured !== undefined) {
    const value = parseBackendReadinessTimeoutMs(input.configured);
    if (value !== null) return { value, source: 'config', ignored };
    ignored.push({ source: 'config', detail: invalidDetail(String(input.configured)) });
  }
  return { value: DEFAULT_BACKEND_READINESS_TIMEOUT_MS, source: 'default', ignored };
}

/**
 * supervisor の実行時入力 (process.env と config store) から解決する。
 * config store が読めなくても backend 起動を止めない: 未設定として扱い、理由を `ignored` に残す。
 */
export function loadBackendReadinessTimeout(
  env: NodeJS.ProcessEnv = process.env,
  readConfigured: () => unknown = getBackendReadinessTimeoutOverride,
): BackendReadinessTimeoutResolution {
  let configured: unknown = null;
  let readFailure: IgnoredBackendReadinessTimeout | null = null;
  try {
    configured = readConfigured();
  } catch (error) {
    readFailure = {
      source: 'config',
      detail: `config store unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const resolution = resolveBackendReadinessTimeout({ env: env[BACKEND_READINESS_TIMEOUT_ENV], configured });
  return readFailure ? { ...resolution, ignored: [...resolution.ignored, readFailure] } : resolution;
}

function parseBackendReadinessTimeoutMs(raw: unknown): number | null {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return null;
  }
  if (!Number.isSafeInteger(value)) return null;
  return value >= MIN_BACKEND_READINESS_TIMEOUT_MS && value <= MAX_BACKEND_READINESS_TIMEOUT_MS ? value : null;
}

function invalidDetail(raw: string): string {
  return `${JSON.stringify(raw.slice(0, 64))} is not an integer within `
    + `${MIN_BACKEND_READINESS_TIMEOUT_MS}..${MAX_BACKEND_READINESS_TIMEOUT_MS} ms`;
}
