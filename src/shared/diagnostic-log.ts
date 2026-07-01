import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const path = resolve(process.cwd(), process.env.EXCUBITOR_DIAG_LOG ?? 'logs/excubitor-diagnostic.log');

export function writeDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
  } catch {
    // Last-resort diagnostics must never crash the server.
  }
}
