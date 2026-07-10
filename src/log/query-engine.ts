import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection, Json } from '@duckdb/node-api';
import { listVestigiumServices } from './vestigium-reader.js';
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

export async function queryLogs(logsRoot: string, query: LogQuery): Promise<QueriedLogLine[]> {
  const files = resolveLogFiles(logsRoot, query);
  if (files.length === 0) return [];
  return withDuckDb(async (connection) => executeQuery(connection, files, query));
}

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
