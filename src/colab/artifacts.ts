import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { colabJobDir, type ColabCli } from './cli.js';
import { readBoundedFile, sha256Bytes, verifyArtifactBytes } from './artifact-integrity.js';
import type { ColabJob } from './journal.js';
import { artifactSchema, MAX_ARTIFACT_BYTES, MAX_OUTPUTS, MAX_RESULT_BYTES, RESULT_NAME, type ColabArtifact } from './protocol.js';

const MAX_PROGRAM_BYTES = 8 * 1024 * 1024;
const resultSchema = z.object({
  version: z.literal(1),
  attemptId: z.string(),
  sourceRevision: z.string(),
  exitCode: z.number().int().safe(),
  tests: z.object({
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).refine(tests => tests.failed + tests.skipped <= tests.total).optional(),
  metrics: z.record(z.number().finite()).optional(),
  checkpoints: z.array(artifactSchema).max(MAX_OUTPUTS).default([]),
}).strict().refine(report => report.tests !== undefined || Object.keys(report.metrics ?? {}).length > 0);

export async function privateJobRoot(path: string): Promise<boolean> {
  const [info, actual] = await Promise.all([stat(path), realpath(path)]);
  return actual === path && info.isDirectory() &&
    (process.getuid === undefined || (info.uid === process.getuid() && (info.mode & 0o077) === 0));
}

export async function stageColabProgram(job: ColabJob): Promise<string> {
  const bytes = await readBoundedFile(job.program.path, MAX_PROGRAM_BYTES);
  if (sha256Bytes(bytes) !== job.program.sha256) throw new Error('colab_program_digest_mismatch');
  const jobDir = colabJobDir(job);
  await mkdir(jobDir, { mode: 0o700 });
  const file = join(jobDir, job.program.path.endsWith('.ipynb') ? 'program.ipynb' : 'program.py');
  await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  return file;
}

const artifactDir = (job: ColabJob) => join(colabJobDir(job), 'files');
const sizeLimit = (name: string) => name === RESULT_NAME ? MAX_RESULT_BYTES : MAX_ARTIFACT_BYTES;

export async function snapshotColabArtifacts(job: ColabJob, cli: ColabCli, signal: AbortSignal): Promise<{
  files: ColabArtifact[]; exitCode: number;
}> {
  await mkdir(artifactDir(job), { mode: 0o700 });
  const download = async (name: string) => {
    signal.throwIfAborted();
    const file = join(artifactDir(job), name);
    if (!await cli.download(job, name, file, signal)) throw new Error('colab_download_failed');
    return readBoundedFile(file, sizeLimit(name));
  };
  const result = await download(RESULT_NAME);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(result);
  const report = resultSchema.parse(JSON.parse(text));
  if (report.attemptId !== job.request.idempotencyKey || report.sourceRevision !== job.request.sourceRevision ||
      report.checkpoints.length !== job.program.outputs.length) throw new Error('colab_result_mismatch');
  const expected = new Map(report.checkpoints.map(file => [file.name, file]));
  const files: ColabArtifact[] = [{ name: RESULT_NAME, bytes: result.byteLength, sha256: sha256Bytes(result) }];
  for (const name of job.program.outputs) {
    const entry = expected.get(name);
    if (!entry) throw new Error('colab_artifact_missing');
    const bytes = await download(name);
    if (!verifyArtifactBytes({ bytes, expected: entry, limit: sizeLimit(name) })) throw new Error('colab_artifact_digest_mismatch');
    files.push(entry);
  }
  return { files, exitCode: report.exitCode };
}

export async function readColabArtifact(job: ColabJob, entry: ColabArtifact): Promise<Buffer> {
  const limit = sizeLimit(entry.name);
  const bytes = await readBoundedFile(join(artifactDir(job), entry.name), limit);
  if (!verifyArtifactBytes({ bytes, expected: entry, limit })) throw new Error('colab_artifact_digest_mismatch');
  return bytes;
}
