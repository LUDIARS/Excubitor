import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const DEFAULT_DATABASE_URL =
  'postgresql://excubitor_user:excubitor@localhost:5432/excubitor';

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

// dev で migration を跨いで hot reload する場合、 prepared statement の plan が
// stale な column を見続けてしまうことがあるため prepare を切る (production も問題なし)。
const queryClient = postgres(databaseUrl, {
  max: 10,
  idle_timeout: 20,
  prepare: false,
  // production では削除して良い、 dev で「hot reload + DB cleanup」直後に SHOW DEBUG が要るとき用
});

export const db = drizzle(queryClient, { schema });
export { schema };
