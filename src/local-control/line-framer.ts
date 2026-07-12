import { LOCAL_CONTROL_MAX_LINE_BYTES } from './protocol.js';

export class LineTooLongError extends Error {
  constructor(maxBytes: number) {
    super(`local-control frame exceeds ${maxBytes} bytes`);
    this.name = 'LineTooLongError';
  }
}

export class NewlineJsonFramer {
  private pending = '';

  constructor(private readonly maxBytes = LOCAL_CONTROL_MAX_LINE_BYTES) {}

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines: string[] = [];
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const raw = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) throw new LineTooLongError(this.maxBytes);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.length > 0) lines.push(line);
      newline = this.pending.indexOf('\n');
    }
    if (Buffer.byteLength(this.pending, 'utf8') > this.maxBytes) throw new LineTooLongError(this.maxBytes);
    return lines;
  }
}
