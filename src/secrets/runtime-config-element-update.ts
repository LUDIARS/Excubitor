/**
 * runtime config の配列要素を、値本文を返さずに条件一致で書き換える純関数。
 * 全体 PUT は既存の値 (共有 secret を含む) を知らないと使えないため、
 * 「どの要素を・どう変えるか」だけを受け取り、結果は一致件数だけで返す。
 * @implements SPEC-SERVICE-RUNTIME-CONFIG-ELEMENT-UPDATE
 */
import type { ServiceRuntimeConfig } from './config-store.js';

export type RuntimeConfigScalar = string | number | boolean | null;

export interface RuntimeConfigElementUpdate {
  /** 対象のトップレベルキー。値は object の配列であること。 */
  key: string;
  /** 全フィールドが厳密一致した要素だけを対象にする。null は「値が null または未設定」。 */
  match: Record<string, RuntimeConfigScalar>;
  /** 一致した要素に上書きするフィールド。remove と同時には指定できない。 */
  set?: Record<string, RuntimeConfigScalar>;
  /** true なら一致した要素を配列から外す。 */
  remove?: boolean;
}

export interface RuntimeConfigElementUpdateResult {
  config: ServiceRuntimeConfig;
  matched: number;
}

export class RuntimeConfigElementUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigElementUpdateError';
  }
}

function fieldMatches(element: Record<string, unknown>, field: string, expected: RuntimeConfigScalar): boolean {
  const actual = element[field];
  return expected === null ? actual === null || actual === undefined : actual === expected;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 一致しなければ元の config をそのまま返す (matched=0)。エラー文に値本文を含めない。
 */
export function updateRuntimeConfigElements(
  current: ServiceRuntimeConfig | null,
  update: RuntimeConfigElementUpdate,
): RuntimeConfigElementUpdateResult {
  if (Object.keys(update.match).length === 0) throw new RuntimeConfigElementUpdateError('match must name at least one field');
  if ((update.remove === true) === (update.set !== undefined)) {
    throw new RuntimeConfigElementUpdateError('specify exactly one of set or remove');
  }
  if (update.set !== undefined && Object.keys(update.set).length === 0) {
    throw new RuntimeConfigElementUpdateError('set must name at least one field');
  }
  if (current === null) throw new RuntimeConfigElementUpdateError('runtime config is not configured');
  const list = current[update.key];
  if (!Array.isArray(list)) throw new RuntimeConfigElementUpdateError(`${update.key} is not an array`);

  let matched = 0;
  const next: unknown[] = [];
  for (const element of list) {
    const hit = isPlainObject(element)
      && Object.entries(update.match).every(([field, expected]) => fieldMatches(element, field, expected));
    if (!hit) { next.push(element); continue; }
    matched++;
    if (update.remove) continue;
    next.push({ ...element, ...update.set });
  }
  return matched === 0
    ? { config: current, matched }
    : { config: { ...current, [update.key]: next }, matched };
}
