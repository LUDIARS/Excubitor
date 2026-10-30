import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSupervisorLogger,
  installSupervisorFatalHandlers,
  supervisorLogPath,
} from './supervisor-log.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('supervisorLogPath', () => {
  it('places the supervisor log next to the managed process logs', () => {
    expect(supervisorLogPath(join('E:', 'ex'))).toBe(join('E:', 'ex', 'data', 'process-logs', 'excubitor-supervisor.log'));
  });
});

describe('createSupervisorLogger', () => {
  it('writes records to the supervisor log file synchronously', () => {
    const root = mkdtempSync(join(tmpdir(), 'ex-supervisor-log-'));
    roots.push(root);
    const logger = createSupervisorLogger(root, 'info');
    logger.fatal({ err: 'boom' }, 'supervisor uncaught exception');
    const text = readFileSync(supervisorLogPath(root), 'utf8');
    const record = JSON.parse(text.trim().split('\n').at(-1)!);
    expect(record).toMatchObject({ name: 'excubitor.supervisor', err: 'boom', msg: 'supervisor uncaught exception', level: 60 });
  });
});

describe('installSupervisorFatalHandlers', () => {
  function setup() {
    const target = new EventEmitter();
    const fatal: Array<{ fields: unknown; msg: string }> = [];
    const exits: number[] = [];
    installSupervisorFatalHandlers(
      target as never,
      { fatal: ((fields: unknown, msg: string) => { fatal.push({ fields, msg }); }) as never },
      (code) => { exits.push(code); },
    );
    return { target, fatal, exits };
  }

  it('records an uncaught exception with its stack and exits 1', () => {
    const { target, fatal, exits } = setup();
    target.emit('uncaughtException', new Error('EBUSY pipe'));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]!.fields).toMatchObject({ err: 'EBUSY pipe' });
    expect((fatal[0]!.fields as { stack?: string }).stack).toContain('EBUSY pipe');
    expect(exits).toEqual([1]);
  });

  it('records a non-Error rejection reason as text and exits 1', () => {
    const { target, fatal, exits } = setup();
    target.emit('unhandledRejection', 'timeout');
    expect(fatal[0]!.fields).toEqual({ err: 'timeout' });
    expect(fatal[0]!.msg).toContain('unhandled rejection');
    expect(exits).toEqual([1]);
  });
});
