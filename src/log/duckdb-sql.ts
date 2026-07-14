/** DuckDB SQL に埋め込む、内部で列挙済みのファイルパス用リテラル。 */
export function duckDbString(value: string): string {
  return `'${value.replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

export function duckDbStringList(values: readonly string[]): string {
  return `[${values.map(duckDbString).join(', ')}]`;
}
