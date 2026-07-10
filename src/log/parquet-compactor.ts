import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DuckDBConnection, Json } from '@duckdb/node-api';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { sharedLogsRoot } from './logs-root.js';
import { listVestigiumServices } from './vestigium-reader.js';
import { withDuckDb } from './duckdb-session.js';
import { duckDbString } from './duckdb-sql.js';

const logger = createNamedLogger('excubitor.parquet-compactor');
const DAY_MS = 86_400_000;

export interface CompactionSummary {
  date: string;
  compacted: number;
  skipped: number;
  failed: number;
}

export interface ParquetCompactionLoopHandle {
  stop: () => void;
}

export async function compactPreviousDay(logsRoot: string, now = Date.now()): Promise<CompactionSummary> {
  const date = utcDate(now - DAY_MS);
  const jsonlFiles = listVestigiumServices(logsRoot)
    .map((code) => ({ code, file: path.join(logsRoot, code, `${date}.jsonl`) }))
    .filter((target) => fs.existsSync(target.file));
  const summary: CompactionSummary = { date, compacted: 0, skipped: 0, failed: 0 };
  if (jsonlFiles.length === 0) return summary;

  await withDuckDb(async (connection) => {
    for (const target of jsonlFiles) {
      try {
        const compacted = await compactFile(connection, target.file);
        if (compacted) summary.compacted += 1;
        else summary.skipped += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn({ code: target.code, date, err: (err as Error).message }, 'parquet compaction failed');
      }
    }
  });
  return summary;
}

async function compactFile(connection: DuckDBConnection, jsonlFile: string): Promise<boolean> {
  const parquetFile = jsonlFile.replace(/\.jsonl$/, '.parquet');
  const sourceRows = await countJsonRows(connection, jsonlFile);
  if (sourceRows === 0) return false;

  if (fs.existsSync(parquetFile)) {
    const existingRows = await countParquetRows(connection, parquetFile);
    if (existingRows !== sourceRows) {
      throw new Error(`existing parquet row count mismatch (${existingRows} != ${sourceRows})`);
    }
    fs.rmSync(jsonlFile);
    return true;
  }

  const temporaryFile = `${parquetFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await connection.run(`
      COPY (
        SELECT * FROM read_json_auto(
          ${duckDbString(jsonlFile)},
          format='newline_delimited',
          ignore_errors=true
        )
      ) TO ${duckDbString(temporaryFile)} (FORMAT PARQUET, COMPRESSION ZSTD)
    `);
    const parquetRows = await countParquetRows(connection, temporaryFile);
    if (parquetRows !== sourceRows) {
      throw new Error(`parquet row count mismatch (${parquetRows} != ${sourceRows})`);
    }
    fs.renameSync(temporaryFile, parquetFile);
    fs.rmSync(jsonlFile);
    return true;
  } finally {
    if (fs.existsSync(temporaryFile)) fs.rmSync(temporaryFile, { force: true });
  }
}

async function countJsonRows(connection: DuckDBConnection, file: string): Promise<number> {
  return countRows(
    connection,
    `read_json_auto(${duckDbString(file)}, format='newline_delimited', ignore_errors=true)`,
  );
}

async function countParquetRows(connection: DuckDBConnection, file: string): Promise<number> {
  return countRows(connection, `read_parquet(${duckDbString(file)})`);
}

async function countRows(connection: DuckDBConnection, source: string): Promise<number> {
  const reader = await connection.runAndReadAll(`SELECT COUNT(*) AS count FROM ${source}`);
  const row = reader.getRowObjectsJson()[0] as Record<string, Json> | undefined;
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('DuckDB returned an invalid row count');
  return count;
}

export function sweepParquetRetention(logsRoot: string, retentionDays: number, now = Date.now()): number {
  const cutoff = utcDate(now - retentionDays * DAY_MS);
  let deleted = 0;
  for (const code of listVestigiumServices(logsRoot)) {
    const serviceDir = path.join(logsRoot, code);
    for (const name of fs.readdirSync(serviceDir)) {
      const match = /^(\d{4}-\d{2}-\d{2})\.parquet$/.exec(name);
      if (!match || match[1]! >= cutoff) continue;
      fs.rmSync(path.join(serviceDir, name));
      deleted += 1;
    }
  }
  return deleted;
}

export function startParquetCompactionLoop(
  getCatalog: () => Catalog,
  getLogsRoot: () => string = sharedLogsRoot,
): ParquetCompactionLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    const hourUtc = getCatalog().log_store.compact_hour_utc;
    timer = setTimeout(() => {
      void tick().catch((err: unknown) => {
        logger.warn({ err: (err as Error).message }, 'parquet compaction tick failed');
      });
    }, millisecondsUntilHour(hourUtc));
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const catalog = getCatalog();
      const logsRoot = getLogsRoot();
      const summary = await compactPreviousDay(logsRoot);
      const parquetDeleted = catalog.retention.enabled
        ? sweepParquetRetention(logsRoot, catalog.retention.parquet_days)
        : 0;
      if (summary.compacted > 0 || summary.failed > 0 || parquetDeleted > 0) {
        logger.info({ ...summary, parquet_deleted: parquetDeleted }, 'parquet maintenance');
      }
    } finally {
      if (!stopped) schedule();
    }
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function millisecondsUntilHour(hourUtc: number, now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
