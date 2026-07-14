import net from 'node:net';
import tls from 'node:tls';
import { createNamedLogger } from './logger.js';

type RespValue = string | number | null | RespValue[];

const logger = createNamedLogger('excubitor.redis-cache');
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const COMMAND_TIMEOUT_MS = readPositiveIntEnv('EXCUBITOR_REDIS_TIMEOUT_MS', 20);
const FAILURE_BACKOFF_MS = readPositiveIntEnv('EXCUBITOR_REDIS_FAILURE_BACKOFF_MS', 2_000);

let disabledUntil = 0;
let lastWarnAt = 0;

export function redisCacheKey(name: string): string {
  const prefix = process.env.EXCUBITOR_REDIS_PREFIX?.trim() || 'excubitor';
  return `${prefix}:cache:${name}`;
}

export async function readRedisJson<T>(key: string): Promise<T | null> {
  const value = await redisCommand(['GET', key]).catch((err: unknown) => {
    noteRedisFailure(err);
    return null;
  });
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function writeRedisJson(key: string, value: unknown, ttlMs: number): Promise<void> {
  const ttl = Math.max(1, Math.floor(ttlMs));
  await redisCommand(['SET', key, JSON.stringify(value), 'PX', String(ttl)]).catch((err: unknown) => {
    noteRedisFailure(err);
  });
}

export async function deleteRedisKey(key: string): Promise<void> {
  await redisCommand(['DEL', key]).catch((err: unknown) => {
    noteRedisFailure(err);
  });
}

export async function acquireRedisLock(key: string, ttlMs: number): Promise<boolean | null> {
  const ttl = Math.max(1, Math.floor(ttlMs));
  const value = await redisCommand(['SET', key, `${process.pid}:${Date.now()}`, 'PX', String(ttl), 'NX']).catch((err: unknown) => {
    noteRedisFailure(err);
    return undefined;
  });
  if (value === undefined) return null;
  return value === 'OK';
}

async function redisCommand(args: string[]): Promise<RespValue> {
  if (!redisEnabled()) throw new Error('redis disabled');
  if (Date.now() < disabledUntil) throw new Error('redis temporarily unavailable');

  const url = redisUrl();
  const commands: string[][] = [];
  if (url.password) {
    commands.push(url.username ? ['AUTH', decodeURIComponent(url.username), decodeURIComponent(url.password)] : ['AUTH', decodeURIComponent(url.password)]);
  }
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;
  if (Number.isInteger(db) && db > 0) commands.push(['SELECT', String(db)]);
  commands.push(args);

  return new Promise<RespValue>((resolve, reject) => {
    const socket = url.protocol === 'rediss:'
      ? tls.connect({ host: url.hostname, port: portOf(url), servername: url.hostname })
      : net.connect({ host: url.hostname, port: portOf(url) });
    let buffer = Buffer.alloc(0);
    const replies: RespValue[] = [];
    let settled = false;

    const finish = (err: Error | null, value?: RespValue): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? null);
    };

    const timer = setTimeout(() => finish(new Error('redis command timeout')), COMMAND_TIMEOUT_MS);
    timer.unref?.();

    socket.on('connect', () => {
      socket.write(commands.map(encodeCommand).join(''));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const parsed = parseResp(buffer, 0);
          if (!parsed) break;
          replies.push(parsed.value);
          buffer = buffer.subarray(parsed.offset);
          if (replies.length >= commands.length) {
            finish(null, replies[replies.length - 1]);
            return;
          }
        }
      } catch (err) {
        finish(err as Error);
      }
    });
    socket.on('error', (err) => finish(err));
    socket.on('close', () => {
      if (!settled) finish(new Error('redis connection closed'));
    });
  });
}

function redisEnabled(): boolean {
  const raw = process.env.EXCUBITOR_REDIS_ENABLED;
  if (raw && /^(0|false|no)$/i.test(raw)) return false;
  return true;
}

function redisUrl(): URL {
  return new URL(process.env.EXCUBITOR_REDIS_URL || process.env.REDIS_URL || DEFAULT_REDIS_URL);
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'rediss:' ? 6380 : 6379;
}

function encodeCommand(parts: string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const bytes = Buffer.byteLength(part);
    out += `$${bytes}\r\n${part}\r\n`;
  }
  return out;
}

function parseResp(buffer: Buffer, offset: number): { value: RespValue; offset: number } | null {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]!);
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;

  if (prefix === '+') return { value: line, offset: next };
  if (prefix === '-') throw new Error(`redis error: ${line}`);
  if (prefix === ':') return { value: Number(line), offset: next };
  if (prefix === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: next };
    const end = next + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString('utf8', next, end), offset: end + 2 };
  }
  if (prefix === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, offset: next };
    const values: RespValue[] = [];
    let cursor = next;
    for (let i = 0; i < count; i++) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: values, offset: cursor };
  }
  throw new Error(`unsupported redis response: ${prefix}`);
}

function noteRedisFailure(err: unknown): void {
  disabledUntil = Date.now() + FAILURE_BACKOFF_MS;
  const now = Date.now();
  if (now - lastWarnAt < 30_000) return;
  lastWarnAt = now;
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Redis cache unavailable');
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
