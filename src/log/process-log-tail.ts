import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { publish, type Channel } from './bus.js';
import { processLogDir } from './process-file.js';

const logger = createNamedLogger('excubitor.process-log-tail');
const DEFAULT_POLL_MS = 1_000;
const READ_CHUNK_BYTES = 256 * 1024;
const INITIAL_BACKFILL_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_LINE_BYTES = 1024 * 1024;

interface Cursor {
  code: string;
  channel: Channel;
  path: string;
  readOffset: number;
  committedOffset: number;
  pending: Buffer;
  discardUntilNewline: boolean;
}

interface PersistedOffsets {
  version: 1;
  offsets: Record<string, number>;
}

export interface ProcessLogTailOptions {
  logDir?: string;
  statePath?: string;
  pollMs?: number;
  maxPendingLineBytes?: number;
  publishLine?: (event: { service_code: string; channel: Channel; ts: Date; line: string }) => Promise<void>;
}

export interface ProcessLogTailHandle {
  refresh(catalog: Catalog): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Tail the detached process files owned by the local supervisor from inside
 * the observability process. Persisted byte offsets let Ex ingest lines written
 * while its Web/API process was down without making lifecycle depend on Ex.
 */
export async function startProcessLogTail(
  catalog: Catalog,
  options: ProcessLogTailOptions = {},
): Promise<ProcessLogTailHandle> {
  const tail = new ProcessLogTail(options);
  await tail.start(catalog);
  return tail;
}

export class ProcessLogTail implements ProcessLogTailHandle {
  private readonly logDir: string;
  private readonly statePath: string;
  private readonly pollMs: number;
  private readonly publishLine: NonNullable<ProcessLogTailOptions['publishLine']>;
  private readonly maxPendingLineBytes: number;
  private readonly cursors = new Map<string, Cursor>();
  private offsets: Record<string, number> = {};
  private timer: NodeJS.Timeout | null = null;
  private tickTail: Promise<void> = Promise.resolve();
  private stopped = false;
  private offsetsDirty = false;

  constructor(options: ProcessLogTailOptions = {}) {
    this.logDir = options.logDir ?? processLogDir();
    this.statePath = options.statePath ?? join(this.logDir, '.observer-offsets.json');
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.maxPendingLineBytes = options.maxPendingLineBytes ?? DEFAULT_MAX_PENDING_LINE_BYTES;
    if (!Number.isInteger(this.maxPendingLineBytes) || this.maxPendingLineBytes <= 0) {
      throw new Error('maxPendingLineBytes must be a positive integer');
    }
    this.publishLine = options.publishLine ?? publish;
  }

  async start(catalog: Catalog): Promise<void> {
    this.offsets = await readOffsets(this.statePath);
    await this.refresh(catalog);
    this.schedule();
  }

  async refresh(catalog: Catalog): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const wanted = new Set(catalog.services.map((service) => service.code));
    for (const code of wanted) {
      await this.ensureCursor(code, 'stdout');
      await this.ensureCursor(code, 'stderr');
    }
    for (const [key, cursor] of this.cursors) {
      if (!wanted.has(cursor.code)) this.cursors.delete(key);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tickTail;
    await this.persistOffsets();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickTail = this.tickTail
        .then(() => this.tick())
        .catch((error: unknown) => logger.error({ err: asError(error).message }, 'process log tail tick failed'))
        .finally(() => this.schedule());
    }, this.pollMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    for (const cursor of this.cursors.values()) {
      try {
        await this.drain(cursor);
      } catch (error) {
        logger.warn(
          { code: cursor.code, channel: cursor.channel, err: asError(error).message },
          'process log tail drain failed',
        );
      }
    }
    await this.persistOffsets();
  }

  private async ensureCursor(code: string, channel: Channel): Promise<void> {
    const key = `${code}:${channel}`;
    if (this.cursors.has(key)) return;
    const suffix = channel === 'stderr' ? 'err' : 'out';
    const path = join(this.logDir, `${code}.${suffix}.log`);
    const size = await safeSize(path);
    const saved = this.offsets[path];
    const offset = saved === undefined ? Math.max(0, size - INITIAL_BACKFILL_BYTES) : Math.min(saved, size);
    this.cursors.set(key, {
      code,
      channel,
      path,
      readOffset: offset,
      committedOffset: offset,
      pending: Buffer.alloc(0),
      discardUntilNewline: saved === undefined && offset > 0,
    });
  }

  private async drain(cursor: Cursor): Promise<void> {
    const size = await safeSize(cursor.path);
    if (size < cursor.readOffset) {
      cursor.readOffset = 0;
      cursor.committedOffset = 0;
      cursor.pending = Buffer.alloc(0);
      cursor.discardUntilNewline = false;
    }
    if (size === cursor.readOffset) return;

    const length = Math.min(READ_CHUNK_BYTES, size - cursor.readOffset);
    const bytes = Buffer.alloc(length);
    const file = await open(cursor.path, 'r');
    try {
      const result = await file.read(bytes, 0, length, cursor.readOffset);
      if (result.bytesRead === 0) return;
      const nextReadOffset = cursor.readOffset + result.bytesRead;
      const combined = Buffer.concat([cursor.pending, bytes.subarray(0, result.bytesRead)]);
      let lineStart = 0;
      let nextDiscardUntilNewline = cursor.discardUntilNewline;
      if (nextDiscardUntilNewline) {
        const firstNewline = combined.indexOf(0x0a);
        if (firstNewline === -1) {
          cursor.pending = Buffer.alloc(0);
          cursor.readOffset = nextReadOffset;
          cursor.committedOffset = nextReadOffset;
          this.offsets[cursor.path] = cursor.committedOffset;
          this.offsetsDirty = true;
          return;
        }
        lineStart = firstNewline + 1;
        nextDiscardUntilNewline = false;
      }
      for (let index = lineStart; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const raw = combined.subarray(lineStart, index);
        const withoutCr = raw.at(-1) === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
        if (withoutCr.length > this.maxPendingLineBytes) {
          logger.warn(
            { code: cursor.code, channel: cursor.channel, bytes: withoutCr.length },
            'discarding oversized process log line',
          );
        } else if (withoutCr.length > 0) {
          await this.publishLine({
            service_code: cursor.code,
            channel: cursor.channel,
            ts: new Date(),
            line: withoutCr.toString('utf8'),
          });
        }
        lineStart = index + 1;
      }
      // Commit the in-memory/file cursor only after every publish succeeded.
      // A rejected publish therefore replays the chunk on the next tick
      // (at-least-once) instead of silently skipping it.
      cursor.readOffset = nextReadOffset;
      const pending = combined.subarray(lineStart);
      const pendingIsOversized = pending.length > this.maxPendingLineBytes;
      cursor.pending = pendingIsOversized ? Buffer.alloc(0) : Buffer.from(pending);
      cursor.discardUntilNewline = nextDiscardUntilNewline || pendingIsOversized;
      cursor.committedOffset = nextReadOffset - cursor.pending.length;
      this.offsets[cursor.path] = cursor.committedOffset;
      this.offsetsDirty = true;
    } finally {
      await file.close();
    }
  }

  private async persistOffsets(): Promise<void> {
    if (!this.offsetsDirty) return;
    this.offsetsDirty = false;
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, offsets: this.offsets }, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      this.offsetsDirty = true;
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function readOffsets(path: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedOffsets>;
    if (parsed.version !== 1 || typeof parsed.offsets !== 'object' || parsed.offsets === null) return {};
    return Object.fromEntries(
      Object.entries(parsed.offsets).filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    logger.warn({ path, err: asError(error).message }, 'invalid process log offsets; rebuilding from bounded backfill');
    return {};
  }
}

async function safeSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
