import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Bytes } from './artifact-integrity.js';
import { readColabArtifact } from './artifacts.js';
import { ColabCli } from './cli.js';
import type { ColabProcess } from './cli-process.js';
import type { ColabSiteSettings } from './config.js';
import { ColabJournal } from './journal.js';
import type { ColabSubmit } from './protocol.js';
import { ColabRunner } from './runner.js';

const noSessions = '[colab] No active sessions found on server.';
const source = Buffer.from('print(1)\n');
const output = Buffer.from('model');
const revision = '1'.repeat(40);

describe('Colab site lifecycle', () => {
  let root: string;
  let db: Database.Database;
  let journal: ColabJournal;
  let runner: ColabRunner | undefined;
  let site: ColabSiteSettings;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ex-colab-')));
    db = new Database(':memory:');
    journal = new ColabJournal(db);
    const path = join(root, 'registered.py');
    await writeFile(path, source);
    site = {
      enabled: true, cliPath: join(root, 'fake-colab'), jobRoot: root, osUser: 'owner',
      ownerId: 'owner', hqPeerId: 'hq', maxRuntimeSeconds: 60,
      programs: { train: { path, sourceRevision: revision, sha256: sha256Bytes(source), gpu: 'T4', outputs: ['model.bin'] } },
    };
  });

  afterEach(async () => {
    await runner?.close();
    runner = undefined;
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  function request(extra: Partial<ColabSubmit> = {}): ColabSubmit {
    return {
      idempotencyKey: 'attempt-1', ownerId: 'owner', ownerStart: true, programId: 'train',
      sourceRevision: revision, programSha256: sha256Bytes(source), gpu: 'T4',
      deadlineAt: Date.now() + 120_000, code: 'public', data: 'non_confidential', ...extra,
    };
  }

  function create(process: ColabProcess) {
    runner = new ColabRunner(journal, new ColabCli(process), site, () => true);
    return runner;
  }

  it('stages pinned bytes, journals one execution, verifies files and releases after a named stop', async () => {
    const payload = request();
    const commands: string[] = [];
    let session = '';
    const colab = create(async ({ args }) => {
      const command = args[2] === '--config' ? args[4] : args[2];
      commands.push(command ?? '');
      if (command === 'new') session = args[6] ?? '';
      if (command === 'stop') session = '';
      if (command === 'sessions') return { ok: true,
        stdout: session ? `[${session}] endpoint-1 | Hardware: T4 | Shape: Standard | Variant: GPU` : noSessions };
      if (command === 'exec') expect(args).toContain(`CC_CLOUD_INPUT=${JSON.stringify({
        attemptId: payload.idempotencyKey, sourceRevision: revision, uploads: {},
      })}`);
      if (command === 'download' && args[8]) {
        await writeFile(args[8], args[7] === 'content/cc-result.json' ? JSON.stringify({
          version: 1, attemptId: payload.idempotencyKey, sourceRevision: revision, exitCode: 0,
          tests: { total: 1, failed: 0, skipped: 0 },
          checkpoints: [{ name: 'model.bin', bytes: output.length, sha256: sha256Bytes(output) }],
        }) : output);
      }
      return { ok: true, stdout: '' };
    });
    const [first, second] = await Promise.all([colab.submit(payload), colab.submit(payload)]);
    if (!('job' in first && 'job' in second)) throw new Error('expected two receipts');
    expect(first.job.id).toBe(second.job.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(await colab.submit({ ...payload, deadlineAt: payload.deadlineAt + 1000 })).toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(colab.get(first.job.id)?.phase).toBe('released'));
    const job = colab.get(first.job.id);
    if (!job?.files[1]) throw new Error('expected verified artifact');
    expect(job.outcome).toBe('completed');
    expect(await readColabArtifact(job, job.files[1])).toEqual(output);
    expect(commands.filter(command => command === 'new')).toHaveLength(1);
    expect(commands.slice(-3)).toEqual(['stop', 'usage', 'sessions']);
  });

  it('rejects absent owner authorization, unavailable login and modified program bytes before allocation', async () => {
    let loggedIn = false;
    const command = vi.fn<ColabProcess>(async () => ({ ok: loggedIn, stdout: '' }));
    const colab = create(command);
    expect(await colab.submit(request({ ownerId: 'wrong-owner' }))).toMatchObject({ status: 403 });
    expect(command).not.toHaveBeenCalled();
    expect(await colab.submit(request())).toMatchObject({ status: 503, error: 'colab_not_ready' });
    loggedIn = true;
    const program = site.programs.train;
    if (!program) throw new Error('expected registered fixture');
    await writeFile(program.path, 'changed');
    const submitted = await colab.submit(request());
    if (!('job' in submitted)) throw new Error('expected a receipt');
    await vi.waitFor(() => expect(colab.get(submitted.job.id)).toMatchObject({ phase: 'released', outcome: 'failed' }));
    expect(command.mock.calls.every(([arg]) => arg.args.includes('usage'))).toBe(true);
  });

  it('aborts execution at the site deadline and checks release without a caller', async () => {
    site.maxRuntimeSeconds = 1;
    let session = '';
    const commands: string[] = [];
    const colab = create(async ({ args, signal }) => {
      const command = args[2] === '--config' ? args[4] : args[2];
      commands.push(command ?? '');
      if (command === 'new') session = args[6] ?? '';
      if (command === 'stop') session = '';
      if (command === 'sessions') return { ok: true,
        stdout: session ? `[${session}] endpoint-1 | Hardware: T4 | Shape: Standard | Variant: GPU` : noSessions };
      if (command === 'exec' && !signal.aborted) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { ok: !signal.aborted, stdout: '' };
    });
    const submitted = await colab.submit(request());
    if (!('job' in submitted)) throw new Error('expected a receipt');
    await vi.waitFor(() => expect(colab.get(submitted.job.id)).toMatchObject({ phase: 'released', outcome: 'deadline' }), { timeout: 4000 });
    expect(commands.slice(-4)).toEqual(['exec', 'stop', 'usage', 'sessions']);
  });

  it('retains the slot across restart when allocation has no identifiable endpoint', async () => {
    const commands: string[] = [];
    const process: ColabProcess = async ({ args }) => {
      const command = args[2] === '--config' ? args[4] : args[2];
      commands.push(command ?? '');
      return { ok: command !== 'new', stdout: command === 'sessions' ? noSessions : '' };
    };
    const colab = create(process);
    const payload = request();
    const submitted = await colab.submit(payload);
    if (!('job' in submitted)) throw new Error('expected a receipt');
    await vi.waitFor(() => expect(colab.active()?.phase).toBe('release_unknown'));
    await colab.close();
    const restarted = create(process);
    restarted.startRecovery();
    expect(await restarted.submit(request({ idempotencyKey: 'another' }))).toMatchObject({ status: 409, error: 'colab_site_busy' });
    expect(await restarted.submit(payload)).toMatchObject({ created: false, job: { id: submitted.job.id } });
    expect(commands.filter(command => command === 'new')).toHaveLength(1);
    expect(commands).not.toContain('exec');
  });
});
