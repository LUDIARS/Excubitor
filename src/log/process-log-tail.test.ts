import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Catalog } from '../catalog/loader.js';
import { startProcessLogTail } from './process-log-tail.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('process log tail', () => {
  it('resumes from a persisted offset and ingests lines written while Ex was down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excubitor-process-tail-'));
    roots.push(root);
    const statePath = join(root, '.offsets.json');
    const outPath = join(root, 'alpha.out.log');
    await writeFile(outPath, 'before\n', 'utf8');

    const firstLines: string[] = [];
    const first = await startProcessLogTail(catalog(), {
      logDir: root,
      statePath,
      pollMs: 5,
      publishLine: async (event) => { firstLines.push(event.line); },
    });
    await waitFor(() => firstLines.includes('before'));
    await first.stop();

    await appendFile(outPath, 'while-down\n', 'utf8');
    const resumedLines: string[] = [];
    const resumed = await startProcessLogTail(catalog(), {
      logDir: root,
      statePath,
      pollMs: 5,
      publishLine: async (event) => { resumedLines.push(event.line); },
    });
    await waitFor(() => resumedLines.includes('while-down'));
    await resumed.stop();

    expect(resumedLines).toEqual(['while-down']);
  });

  it('replays a chunk when publishing fails instead of advancing past lost logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excubitor-process-tail-failure-'));
    roots.push(root);
    await writeFile(join(root, 'alpha.out.log'), 'first\nsecond\n', 'utf8');
    const lines: string[] = [];
    let rejected = false;
    const tail = await startProcessLogTail(catalog(), {
      logDir: root,
      statePath: join(root, '.offsets.json'),
      pollMs: 5,
      publishLine: async (event) => {
        if (event.line === 'second' && !rejected) {
          rejected = true;
          throw new Error('temporary publish failure');
        }
        lines.push(event.line);
      },
    });
    await waitFor(() => lines.includes('second'));
    await tail.stop();

    expect(lines).toContain('first');
    expect(lines).toContain('second');
  });

  it('discards an oversized unterminated line and resumes at the next newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excubitor-process-tail-oversized-'));
    roots.push(root);
    await writeFile(join(root, 'alpha.out.log'), `${'x'.repeat(128)}\nkept\n`, 'utf8');
    const lines: string[] = [];
    const tail = await startProcessLogTail(catalog(), {
      logDir: root,
      statePath: join(root, '.offsets.json'),
      pollMs: 5,
      maxPendingLineBytes: 32,
      publishLine: async (event) => { lines.push(event.line); },
    });
    await waitFor(() => lines.includes('kept'));
    await tail.stop();

    expect(lines).toEqual(['kept']);
  });
});

function catalog(): Catalog {
  return {
    project_versions: {},
    services: [{ code: 'alpha', name: 'Alpha', runtime: 'node' }],
    memory_monitor: {},
    retention: {},
    log_store: {},
  } as unknown as Catalog;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}
