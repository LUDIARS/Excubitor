/**
 * Vestigium 縺悟瑞縺・◆ JSONL log file 繧・tail 縺励※縲・譌｢蟄倥・ log bus 縺ｫ豬√☆ bridge縲・
 *
 * - catalog.service.log_path 縺梧欠螳壹＆繧後◆ service 縺ｮ縺ｿ襍ｷ蜍・
 * - 蠖捺律 YYYY-MM-DD.jsonl 繧・follow + 譌･莉伜｢・阜縺ｧ谺｡ file 縺ｸ閾ｪ蜍募・譖ｿ
 * - 1 陦・= JSON parse 竊・bus.publish({service_code, channel, ts, line})
 * - 譌｢蟄・error-detector 縺ｯ縺昴・縺ｾ縺ｾ蜀榊茜逕ｨ (bus 邨檎罰)
 *
 * @ludiars/vestigium 縺ｸ縺ｮ逶ｴ謗･萓晏ｭ倥・驕ｿ縺代◆縺・(Concordia 縺ｮ CI 繧・Vestigium repo
 * 縺九ｉ蛻・ｊ髮｢縺吶◆繧・縲・縺薙％縺ｧ縺ｯ Vestigium 縺ｮ JSONL spec 繧堤峩謗･ implement 縺吶ｋ縲・
 * spec 縺ｮ豁｣譛ｬ縺ｯ LUDIARS/Vestigium/DESIGN.md ﾂｧ2.2縲・
 */

import fs from 'node:fs';
import path from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { publish, type Channel } from './bus.js';
import type { Catalog, Service } from '../catalog/loader.js';

const logger = createNamedLogger('concordia.file-tail');

interface TailState {
  service: Service;
  logsDir: string;
  currentFile: string;
  currentYmd: string;
  offset: number;
  buf: string;
}

const states = new Map<string, TailState>();
let timer: NodeJS.Timeout | null = null;

const POLL_MS = 1000;

function ymdUtc(when: Date): string {
  const y = when.getUTCFullYear().toString().padStart(4, '0');
  const m = (when.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = when.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayFile(logsDir: string, when: Date): string {
  return path.join(logsDir, `${ymdUtc(when)}.jsonl`);
}

function startTailing(svc: Service): void {
  if (!svc.log_path) return;
  if (states.has(svc.code)) return;
  const logsDir = path.resolve(svc.log_path);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    logger.warn({ code: svc.code, err: (err as Error).message }, 'failed to ensure logs dir');
  }
  const now = new Date();
  const currentFile = dayFile(logsDir, now);
  let offset = 0;
  try {
    if (fs.existsSync(currentFile)) {
      offset = fs.statSync(currentFile).size; // start at end (live tail)
    }
  } catch { /* noop */ }
  states.set(svc.code, {
    service: svc,
    logsDir,
    currentFile,
    currentYmd: ymdUtc(now),
    offset,
    buf: '',
  });
  logger.info({ code: svc.code, logs_dir: logsDir, file: currentFile, offset }, 'file-tail started');
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
      handleLine(state.service, line);
    }
  } catch (err) {
    logger.warn({ code: state.service.code, err: (err as Error).message }, 'readMore failed');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

function handleLine(svc: Service, raw: string): void {
  if (!raw.trim()) return;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const ts = typeof obj.ts === 'number' ? new Date(obj.ts) : new Date();
    const channel = (obj.channel === 'stderr' || obj.channel === 'stdout')
      ? (obj.channel as Channel)
      : ('stdout' as Channel);
    const msg = typeof obj.msg === 'string' ? obj.msg : raw;
    void publish({
      service_code: svc.code,
      channel,
      ts,
      line: msg,
    });
  } catch {
    // 髱・JSON line 窶・縺昴・縺ｾ縺ｾ stdout 縺ｨ縺励※ publish
    void publish({
      service_code: svc.code,
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
    for (const state of states.values()) {
      try { drainOne(state); } catch (err) {
        logger.warn({ code: state.service.code, err: (err as Error).message }, 'drain failed');
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

function refresh(catalog: Catalog): void {
  const wantedCodes = new Set<string>();
  for (const svc of catalog.services) {
    if (!svc.log_path) continue;
    wantedCodes.add(svc.code);
    if (!states.has(svc.code)) startTailing(svc);
  }
  for (const code of Array.from(states.keys())) {
    if (!wantedCodes.has(code)) stopTailing(code);
  }
}

/** test 逕ｨ 窶・迴ｾ蝨ｨ tail 荳ｭ縺ｮ繧ｵ繝ｼ繝薙せ繧ｳ繝ｼ繝我ｸ隕ｧ */
export function _tailingCodes(): string[] {
  return Array.from(states.keys());
}


