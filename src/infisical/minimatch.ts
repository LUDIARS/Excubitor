/**
 * 軽量 glob match (依存追加を避けるため inline 実装)。
 * サポート: `*` (任意の文字)、 `?` (1文字)、 完全一致のリテラル。
 *
 * 例:
 *   minimatch('DATABASE_URL', '*_URL') === true
 *   minimatch('AWS_KEY', 'AWS_*') === true
 *   minimatch('FOO', 'BAR') === false
 */
export function minimatch(input: string, pattern: string): boolean {
  // pattern を正規表現に変換
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`);
  return re.test(input);
}
