/**
 * runtime config 契約 (C-5〜C-8) が共有する純粋な形状判定。
 *
 * 述語モジュール本体を小さく保つための補助で、値そのものはログに出さない。
 */

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isServiceCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

/** status は「設定されているか」と「トップレベルのキー名」だけを公開する。 */
export function isRuntimeConfigStatus(value: unknown): boolean {
  if (!isPlainJsonObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'configured' || keys[1] !== 'keys') return false;
  if (typeof value.configured !== 'boolean') return false;
  return Array.isArray(value.keys) && value.keys.every((key) => typeof key === 'string');
}

/** env map は child process へ渡すため全値が string でなければならない。 */
export function isStringEnvMap(value: unknown): value is Record<string, string> {
  return isPlainJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** 注入された runtime config は JSON object として復元できる必要がある。 */
export function isSerializedJsonObject(value: string): boolean {
  try {
    return isPlainJsonObject(JSON.parse(value));
  } catch {
    return false;
  }
}
