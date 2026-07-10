import type { LogLine } from './bus.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface BufferedLogLine {
  id: number;
  code: string;
  channel: LogLine['channel'];
  ts: number;
  level: LogLevel | null;
  line: string;
}

export interface LogRingBufferConfig {
  perService: number;
  global: number;
}

export interface RecentLogOptions {
  codes?: ReadonlySet<string>;
  limit: number;
}

class CircularBuffer<T> {
  private entries: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.entries = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    if (this.count < this.capacity) {
      this.entries[(this.start + this.count) % this.capacity] = value;
      this.count += 1;
      return;
    }
    this.entries[this.start] = value;
    this.start = (this.start + 1) % this.capacity;
  }

  newestFirst(): T[] {
    const result: T[] = [];
    for (let offset = this.count - 1; offset >= 0; offset -= 1) {
      const value = this.entries[(this.start + offset) % this.capacity];
      if (value !== undefined) result.push(value);
    }
    return result;
  }

  resize(capacity: number): void {
    const kept = this.newestFirst().slice(0, capacity).reverse();
    this.capacity = capacity;
    this.entries = new Array<T | undefined>(capacity);
    this.start = 0;
    this.count = 0;
    for (const value of kept) this.push(value);
  }
}

export class LogRingBuffer {
  private readonly perService = new Map<string, CircularBuffer<BufferedLogLine>>();
  private globalLines: CircularBuffer<BufferedLogLine>;
  private nextId = 1;

  constructor(private config: LogRingBufferConfig) {
    validateConfig(config);
    this.globalLines = new CircularBuffer<BufferedLogLine>(config.global);
  }

  configure(config: LogRingBufferConfig): void {
    validateConfig(config);
    this.config = config;
    this.globalLines.resize(config.global);
    for (const lines of this.perService.values()) lines.resize(config.perService);
  }

  append(line: LogLine): BufferedLogLine {
    const buffered: BufferedLogLine = {
      id: this.nextId,
      code: line.service_code,
      channel: line.channel,
      ts: line.ts.getTime(),
      level: inferLevel(line),
      line: line.line,
    };
    this.nextId += 1;
    this.globalLines.push(buffered);
    let serviceLines = this.perService.get(line.service_code);
    if (!serviceLines) {
      serviceLines = new CircularBuffer<BufferedLogLine>(this.config.perService);
      this.perService.set(line.service_code, serviceLines);
    }
    serviceLines.push(buffered);
    return buffered;
  }

  recent(options: RecentLogOptions): BufferedLogLine[] {
    const result: BufferedLogLine[] = [];
    for (const line of this.globalLines.newestFirst()) {
      if (options.codes && !options.codes.has(line.code)) continue;
      result.push(line);
      if (result.length >= options.limit) break;
    }
    return result;
  }

  recentForService(code: string, limit: number): BufferedLogLine[] {
    return this.perService.get(code)?.newestFirst().slice(0, limit) ?? [];
  }

  clear(): void {
    this.perService.clear();
    this.globalLines = new CircularBuffer<BufferedLogLine>(this.config.global);
    this.nextId = 1;
  }
}

function validateConfig(config: LogRingBufferConfig): void {
  if (!Number.isInteger(config.perService) || config.perService <= 0) {
    throw new Error('ring_lines_per_service must be a positive integer');
  }
  if (!Number.isInteger(config.global) || config.global <= 0) {
    throw new Error('ring_lines_global must be a positive integer');
  }
}

function inferLevel(line: LogLine): LogLevel | null {
  if (line.channel === 'stderr') return 'error';
  const value = line.line.toLowerCase();
  if (/\bfatal\b/.test(value)) return 'fatal';
  if (/\b(error|err|exception|traceback)\b/.test(value)) return 'error';
  if (/\b(warn|warning)\b/.test(value)) return 'warn';
  if (/\binfo\b/.test(value)) return 'info';
  if (/\bdebug\b/.test(value)) return 'debug';
  if (/\btrace\b/.test(value)) return 'trace';
  return null;
}

const DEFAULT_CONFIG: LogRingBufferConfig = { perService: 2_000, global: 20_000 };
const sharedBuffer = new LogRingBuffer(DEFAULT_CONFIG);

export function configureLogRingBuffer(config: LogRingBufferConfig): void {
  sharedBuffer.configure(config);
}

export function appendLogLine(line: LogLine): BufferedLogLine {
  return sharedBuffer.append(line);
}

export function recentLogLines(options: RecentLogOptions): BufferedLogLine[] {
  return sharedBuffer.recent(options);
}

export function recentServiceLogLines(code: string, limit: number): BufferedLogLine[] {
  return sharedBuffer.recentForService(code, limit);
}

export function resetLogRingBufferForTests(): void {
  sharedBuffer.clear();
}
