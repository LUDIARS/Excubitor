import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readCurrentHead } from '../federation/self-version.js';

/** @implements SPEC-EX-UNIFIED-UPDATE */
const IdentitySchema = z.object({ pid: z.number().int().positive(), started_at: z.string() });
const VersionSchema = IdentitySchema.extend({ hash: z.string().nullable() });
export type SupervisorGeneration = z.infer<typeof IdentitySchema>;
export type SupervisorVersion = z.infer<typeof VersionSchema>;

export async function readSupervisorGeneration(root: string): Promise<SupervisorGeneration> {
  const state: unknown = JSON.parse(await readFile(join(root, 'data', 'local-control-state.json'), 'utf8'));
  return z.object({ supervisor: IdentitySchema }).parse(state).supervisor;
}

export async function readSupervisorVersion(root: string): Promise<SupervisorVersion | null> {
  try {
    return VersionSchema.parse(JSON.parse(await readFile(join(root, 'data', 'supervisor-version.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // First upgrade from versions without this receipt.
    throw error;
  }
}

export async function publishSupervisorVersion(root: string, generation: SupervisorGeneration): Promise<void> {
  const head = await readCurrentHead(root);
  const folder = join(root, 'data');
  await mkdir(folder, { recursive: true });
  const path = join(folder, 'supervisor-version.json');
  const temporary = path + '.' + generation.pid + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ ...generation, hash: head.hash }), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
