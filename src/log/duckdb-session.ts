import type { DuckDBConnection } from '@duckdb/node-api';

/** DuckDB の in-memory instance と connection を全経路で解放する。 */
export async function withDuckDb<T>(run: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    return await run(connection);
  } finally {
    try {
      connection?.closeSync();
    } finally {
      instance.closeSync();
    }
  }
}
