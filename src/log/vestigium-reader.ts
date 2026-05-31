/**
 * Vestigium JSONL 繝輔ぃ繧､繝ｫ繧定ｪｭ繧蟆上＆縺ｪ reader縲・file-tail 縺ｨ MCP server 縺ｮ荳｡譁ｹ縺ｧ菴ｿ縺・・
 * Vestigium DESIGN.md ﾂｧ2.2 縺・spec 縺ｮ豁｣譛ｬ縲・@ludiars/vestigium 縺ｸ縺ｮ逶ｴ謗･萓晏ｭ倥ｒ驕ｿ縺代ｋ
 * 縺溘ａ Concordia 蜀・〒蜀榊ｮ溯｣・＠縺ｦ縺・ｋ (drift 豕ｨ諢・窶・spec 螟画峩譎ゅ・荳｡譁ｹ譖ｴ譁ｰ)縲・
 */

import fs from 'node:fs';
import path from 'node:path';

export interface VestigiumRecord {
  ts: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  service: string;
  channel: 'stdout' | 'stderr' | 'app';
  msg: string;
  pid?: number;
  ctx?: Record<string, unknown>;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const CHANNELS = ['stdout', 'stderr', 'app'] as const;

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

/** logsDir 驟堺ｸ・(= log_path 縺ｮ隕ｪ) 縺ｧ <code>/ 繧ｵ繝悶ョ繧｣繝ｬ繧ｯ繝医Μ繧貞・謖・*/
export function listVestigiumServices(logsRoot: string): string[] {
  if (!fs.existsSync(logsRoot)) return [];
  return fs.readdirSync(logsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 縺ゅｋ service 縺ｮ log_path 驟堺ｸ九・ YYYY-MM-DD.jsonl 繧呈眠縺励＞鬆・*/
export function listFiles(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readdirSync(logPath)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse()
    .map((f) => path.join(logPath, f));
}

/** 譛ｫ蟆ｾ 256KB 縺九ｉ陦悟腰菴阪↓隱ｭ繧邁｡譏・reverse reader */
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


