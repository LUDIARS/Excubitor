/**
 * Vestigium が吐く JSONL log file を tail して、 既存の log bus に流す bridge。
 *
 * - 共有ルート `<root>/<code>/` (sharedLogsRoot) 配下を **自動発見** して全サービスを tail。
 *   catalog の `log_path` 明示は不要 (= 全サービスのログが log bus に乗る)。 log_path を
 *   持つサービスはその dir を優先 (root をずらした個別配置にも対応)。
 * - 当日 YYYY-MM-DD.jsonl を follow + 日付境界で次 file へ自動切替。
 * - 1 行 = JSON parse → bus.publish({service_code, channel, ts, line})。
 * - 既存の error-detector はそのまま再利用 (bus 経由)。
 *
 * @ludiars/vestigium への直接依存は避けたい (CI を Vestigium repo から切り離すため)。
 * ここでは Vestigium の JSONL spec を直接 implement する。 spec の正本は
 * LUDIARS/Vestigium/DESIGN.md §2.2。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { publish, type Channel } from './bus.js';
import { sharedLogsRoot } from './logs-root.js';
import { listVestigiumServices } from './vestigium-reader.js';
import type { Catalog } from '../catalog/loader.js';

const logger = createNamedLogger('excubitor.file-tail');

interface TailState {
  code: string;
  logsDir: string;
  currentFile: string;
  currentYmd: string;
  offset: number;
  buf: string;
}

const states = new Map<string, TailState>();
let timer: NodeJS.Timeout | null = null;

const POLL_MS = 1000;
/** 共有ルート配下の新規 `<code>/` を拾い直す間隔 (POLL の倍数)。 */
const REDISCOVER_EVERY = 10;
let tick = 0;

function ymdUtc(when: Date): string {
  const y = when.getUTCFullYear().toString().padStart(4, '0');
  const m = (when.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = when.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayFile(logsDir: string, when: Date): string {
  return path.join(logsDir, `${ymdUtc(when)}.jsonl`);
}

function startTailing(code: string, logsDir: string): void {
  if (states.has(code)) return;
  const resolved = path.resolve(logsDir);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    logger.warn({ code, err: (err as Error).message }, 'failed to ensure logs dir');
  }
  const now = new Date();
  const currentFile = dayFile(resolved, now);
  let offset = 0;
  try {
    if (fs.existsSync(currentFile)) {
      offset = fs.statSync(currentFile).size; // start at end (live tail)
    }
  } catch { /* noop */ }
  states.set(code, {
    code,
    logsDir: resolved,
    currentFile,
    currentYmd: ymdUtc(now),
    offset,
    buf: '',
  });
  logger.info({ code, logs_dir: resolved, file: currentFile, offset }, 'file-tail started');
}

function stopTailing(code: string): void {
  states.delete(code);
}

function drainOne(state: TailState): void {
  const now = new Date();
  const today = ymdUtc(now);
  if (today !== state.currentYmd) {
    readMore(state);
    state.currentYmd = today;
    state.currentFile = dayFile(state.logsDir, now);
    state.offset = 0;
    state.buf = '';
  }
  readMore(state);
}

function readMore(state: TailState): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.currentFile);
  } catch {
    return; // file not yet created
  }
  if (stat.size < state.offset) {
    state.offset = 0;
    state.buf = '';
  }
  if (stat.size === state.offset) return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(state.currentFile, 'r');
    const need = stat.size - state.offset;
    const buffer = Buffer.alloc(need);
    fs.readSync(fd, buffer, 0, need, state.offset);
    state.offset = stat.size;
    state.buf += buffer.toString('utf8');
    let nl: number;
    while ((nl = state.buf.indexOf('\n')) !== -1) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      handleLine(state.code, line);
    }
  } catch (err) {
    logger.warn({ code: state.code, err: (err as Error).message }, 'readMore failed');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

function handleLine(code: string, raw: string): void {
  if (!raw.trim()) return;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const ts = typeof obj.ts === 'number' ? new Date(obj.ts) : new Date();
    const channel = (obj.channel === 'stderr' || obj.channel === 'stdout')
      ? (obj.channel as Channel)
      : ('stdout' as Channel);
    const msg = typeof obj.msg === 'string' ? obj.msg : raw;
    void publish({
      service_code: code,
      channel,
      ts,
      line: msg,
    });
  } catch {
    // 非 JSON line はそのまま stdout として publish
    void publish({
      service_code: code,
      channel: 'stdout',
      ts: new Date(),
      line: raw,
    });
  }
}

export interface FileTailHandle {
  stop(): void;
  refresh(catalog: Catalog): void;
}

export function startFileTail(catalog: Catalog): FileTailHandle {
  refresh(catalog);
  timer = setInterval(() => {
    // 共有ルートに新しく現れた <code>/ を周期的に拾う (サービスが初回 write した直後など)。
    if (tick++ % REDISCOVER_EVERY === 0) discoverFromRoot();
    for (const state of states.values()) {
      try { drainOne(state); } catch (err) {
        logger.warn({ code: state.code, err: (err as Error).message }, 'drain failed');
      }
    }
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      states.clear();
    },
    refresh,
  };
}

/**
 * catalog の log_path 明示分を最優先で確定しつつ、 共有ルート配下の全 `<code>/` を
 * 自動発見して tail 対象にする。 catalog から log_path 持ちサービスが消えても、 そのログ
 * dir が共有ルートに実在する限り tail は継続する (= ログの取りこぼし防止を優先)。
 */
function refresh(catalog: Catalog): void {
  const wanted = new Map<string, string>(); // code -> logsDir
  for (const svc of catalog.services) {
    if (svc.log_path) wanted.set(svc.code, path.resolve(svc.log_path));
  }
  for (const [code, dir] of discoverPairs()) {
    if (!wanted.has(code)) wanted.set(code, dir);
  }
  for (const [code, dir] of wanted) {
    if (!states.has(code)) startTailing(code, dir);
  }
  for (const code of Array.from(states.keys())) {
    if (!wanted.has(code)) stopTailing(code);
  }
}

/** 共有ルート配下の `<code>/` を (code, dir) ペアで列挙。 */
function discoverPairs(): [string, string][] {
  const root = sharedLogsRoot();
  return listVestigiumServices(root).map((code) => [code, path.join(root, code)]);
}

/** 共有ルートに新規出現した `<code>/` だけを追加で tail 開始する (既存は触らない)。 */
function discoverFromRoot(): void {
  for (const [code, dir] of discoverPairs()) {
    if (!states.has(code)) startTailing(code, dir);
  }
}

/** test 用: 現在 tail 中のサービスコード一覧。 */
export function _tailingCodes(): string[] {
  return Array.from(states.keys());
}
