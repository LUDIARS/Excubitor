import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { DuckDBConnection, Json } from '@duckdb/node-api';
import { listVestigiumServices, parseRecord } from './vestigium-reader.js';
import { withDuckDb } from './duckdb-session.js';
import { duckDbString, duckDbStringList } from './duckdb-sql.js';

export type QueryLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogQuery {
  codes?: readonly string[];
  from: number;
  to: number;
  level?: QueryLogLevel;
  contains?: string;
  limit: number;
}

export interface QueriedLogLine {
  code: string;
  ts: number;
  level: string | null;
  channel: string | null;
  line: string;
}

type LogFileFormat = 'jsonl' | 'parquet';

interface LogFileTarget {
  code: string;
  files: string[];
  format: LogFileFormat;
}

/**
 * @implements LOG-STORE-QUERY-JSONL (spec/plan/log-store.md)
 */
export async function queryLogs(logsRoot: string, query: LogQuery): Promise<QueriedLogLine[]> {
  const files = resolveLogFiles(logsRoot, query);
  if (files.length === 0) return [];
  if (files.every((target) => target.format === 'jsonl')) return queryJsonl(files, query);
  return withDuckDb(async (connection) => executeQuery(connection, files, query));
}

/**
 * @implements LOG-STORE-QUERY-JSONL (spec/plan/log-store.md)
 */
async function queryJsonl(files: readonly LogFileTarget[], query: LogQuery): Promise<QueriedLogLine[]> {
  const contains = query.contains?.toLowerCase();
  const results: QueriedLogLine[] = [];
  for (const target of files) {
    for (const file of target.files) {
      const lines = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const record = parseRecord(line);
        if (!record || record.ts < query.from || record.ts > query.to) continue;
        if (query.level && record.level !== query.level) continue;
        if (contains && !record.msg.toLowerCase().includes(contains)) continue;
        addResult(results, {
          code: target.code,
          ts: record.ts,
          level: record.level,
          channel: record.channel,
          line: record.msg,
        }, query.limit);
      }
    }
  }
  return results;
}

function addResult(results: QueriedLogLine[], result: QueriedLogLine, limit: number): void {
  const insertAt = results.findIndex((existing) => existing.ts < result.ts);
  if (insertAt === -1) {
    if (results.length < limit) results.push(result);
    return;
  }
  results.splice(insertAt, 0, result);
  if (results.length > limit) results.pop();
}

/**
 * @implements LOG-STORE-QUERY-JSONL (spec/plan/log-store.md)
 */
function resolveLogFiles(logsRoot: string, query: LogQuery): LogFileTarget[] {
  const available = listVestigiumServices(logsRoot);
  const requestedCodes = query.codes ? new Set(query.codes) : undefined;
  const selected = query.codes
    ? available.filter((code) => requestedCodes?.has(code))
    : available;
  const firstDate = utcDate(query.from);
  const lastDate = utcDate(query.to);
  const targets: LogFileTarget[] = [];
  for (const code of selected) {
    const serviceDir = path.join(logsRoot, code);
    const byDate = new Map<string, { jsonl?: string; parquet?: string }>();
    for (const name of fs.readdirSync(serviceDir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.(jsonl|parquet)$/.exec(name);
      if (!match || match[1]! < firstDate || match[1]! > lastDate) continue;
      const entry = byDate.get(match[1]!) ?? {};
      entry[match[2] as LogFileFormat] = path.join(serviceDir, name);
      byDate.set(match[1]!, entry);
    }
    const jsonl: string[] = [];
    const parquet: string[] = [];
    for (const entry of byDate.values()) {
      if (entry.parquet) parquet.push(entry.parquet);
      else if (entry.jsonl) jsonl.push(entry.jsonl);
    }
    if (jsonl.length > 0) targets.push({ code, files: jsonl, format: 'jsonl' });
    if (parquet.length > 0) targets.push({ code, files: parquet, format: 'parquet' });
  }
  return targets;
}

async function executeQuery(
  connection: DuckDBConnection,
  files: readonly LogFileTarget[],
  query: LogQuery,
): Promise<QueriedLogLine[]> {
  const scans = files.map((target) => scanSql(target)).join('\nUNION ALL\n');
  const filters = ['ts IS NOT NULL', 'line IS NOT NULL', 'ts >= $from', 'ts <= $to'];
  const values: Record<string, number | string> = { from: query.from, to: query.to, limit: query.limit };
  if (query.level) {
    filters.push('level = $level');
    values.level = query.level;
  }
  if (query.contains) {
    filters.push('contains(lower(line), lower($contains))');
    values.contains = query.contains;
  }
  const sql = `
    SELECT code, ts, level, channel, line
    FROM (${scans}) AS log_lines
    WHERE ${filters.join(' AND ')}
    ORDER BY ts DESC
    LIMIT $limit
  `;
  const reader = await connection.runAndReadAll(sql, values);
  return reader.getRowObjectsJson().map(toQueriedLogLine);
}

function scanSql(target: LogFileTarget): string {
  const source = target.format === 'parquet'
    ? `read_parquet(${duckDbStringList(target.files)}, union_by_name=true)`
    : `read_json_auto(
        ${duckDbStringList(target.files)},
        format='newline_delimited',
        ignore_errors=true,
        union_by_name=true,
        columns={ts:'BIGINT', level:'VARCHAR', channel:'VARCHAR', msg:'VARCHAR'}
      )`;
  return `
    SELECT
      ${duckDbString(target.code)} AS code,
      TRY_CAST(ts AS BIGINT) AS ts,
      TRY_CAST(level AS VARCHAR) AS level,
      TRY_CAST(channel AS VARCHAR) AS channel,
      TRY_CAST(msg AS VARCHAR) AS line
    FROM ${source}
  `;
}

function toQueriedLogLine(row: Record<string, Json>): QueriedLogLine {
  const ts = Number(row.ts);
  if (typeof row.code !== 'string' || !Number.isFinite(ts) || typeof row.line !== 'string') {
    throw new Error('DuckDB returned an invalid log row');
  }
  return {
    code: row.code,
    ts,
    level: typeof row.level === 'string' ? row.level : null,
    channel: typeof row.channel === 'string' ? row.channel : null,
    line: row.line,
  };
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
