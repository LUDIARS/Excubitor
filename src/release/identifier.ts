/** 出力ファイル名の構成要素に許す形式。API と直接呼び出しで共有する。 */
export function isReleaseIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value) && !/[^0-9A-Za-z._+-]/.test(value);
}
