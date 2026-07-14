/**
 * Vestigium JSONL ファイルを読む小さな reader、Efile-tail と MCP server の両方で使ぁE��E
 * Vestigium DESIGN.md §2.2 ぁEspec の正本、E@ludiars/vestigium への直接依存を避ける
 * ため Concordia 冁E��再実裁E��てぁE�� (drift 注愁E Espec 変更時�E両方更新)、E
 */

import fs from 'node:fs';
import path from 'node:path';

export interface VestigiumRecord {
  ts: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  service: string;
  channel: 'stdout' | 'stderr' | 'app' | 'llm';
  msg: string;
  pid?: number;
  ctx?: Record<string, unknown>;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const CHANNELS = ['stdout', 'stderr', 'app', 'llm'] as const;

export function parseRecord(line: string): VestigiumRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.ts !== 'number' || typeof obj.service !== 'string' || typeof obj.msg !== 'string') {
      return null;
    }
    const level = (LEVELS as readonly string[]).includes(obj.level as string)
      ? (obj.level as VestigiumRecord['level'])
      : 'info';
    const channel = (CHANNELS as readonly string[]).includes(obj.channel as string)
      ? (obj.channel as VestigiumRecord['channel'])
      : 'app';
    return {
      ts: obj.ts,
      level,
      service: obj.service,
      channel,
      msg: obj.msg,
      pid: typeof obj.pid === 'number' ? obj.pid : undefined,
      ctx: obj.ctx && typeof obj.ctx === 'object'
        ? (obj.ctx as Record<string, unknown>)
        : undefined,
    };
  } catch {
    return null;
  }
}

/** logsDir 配丁E(= log_path の親) で <code>/ サブディレクトリを�E持E*/
export function listVestigiumServices(logsRoot: string): string[] {
  if (!fs.existsSync(logsRoot)) return [];
  return fs.readdirSync(logsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** ある service の log_path 配下�E YYYY-MM-DD.jsonl を新しい頁E*/
export function listFiles(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readdirSync(logPath)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse()
    .map((f) => path.join(logPath, f));
}

/** 末尾 256KB から行単位に読む簡昁Ereverse reader */
function readTailLines(file: string, maxBytes = 256 * 1024): string[] {
  const stat = fs.statSync(file);
  const readBytes = Math.min(stat.size, maxBytes);
  const offset = stat.size - readBytes;
  const buffer = Buffer.alloc(readBytes);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, readBytes, offset);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  if (offset > 0 && lines.length > 0) lines.shift();
  return lines.filter((l) => l.length > 0).reverse();
}

export interface RecentOpts {
  logPath: string;
  limit?: number;
  level?: VestigiumRecord['level'][];
  channel?: VestigiumRecord['channel'][];
  since?: number;
}

export function recent(opts: RecentOpts): VestigiumRecord[] {
  const limit = opts.limit ?? 200;
  const result: VestigiumRecord[] = [];
  for (const file of listFiles(opts.logPath)) {
    for (const line of readTailLines(file)) {
      const rec = parseRecord(line);
      if (!rec) continue;
      if (opts.level && !opts.level.includes(rec.level)) continue;
      if (opts.channel && !opts.channel.includes(rec.channel)) continue;
      if (opts.since !== undefined && rec.ts < opts.since) return result;
      result.push(rec);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

export interface SearchOpts {
  logPaths: { code: string; logPath: string }[];
  pattern: string | RegExp;
  limit?: number;
  since?: number;
}

export function search(opts: SearchOpts): VestigiumRecord[] {
  const re = typeof opts.pattern === 'string' ? new RegExp(opts.pattern, 'i') : opts.pattern;
  const limit = opts.limit ?? 200;
  const all: VestigiumRecord[] = [];
  for (const target of opts.logPaths) {
    const hits = recent({ logPath: target.logPath, limit: 5000, since: opts.since })
      .filter((r) => re.test(r.msg));
    for (const h of hits) all.push(h);
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit);
}

export function lastSeenAt(logPath: string): number | null {
  const files = listFiles(logPath);
  if (files.length === 0) return null;
  const last = readTailLines(files[0]!).find((l) => parseRecord(l) !== null);
  if (!last) return null;
  return parseRecord(last)?.ts ?? null;
}


