import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';

/** @implements SPEC-SERVICE-BOOTSTRAP */
const script = z.string().regex(/^scripts\/[A-Za-z0-9_/-]+\.mjs$/);
const ManifestSchema = z.object({
  version: z.literal(1),
  service: z.string().min(1),
  setup: script,
  data: z.object({ export: script, import: script }).strict(),
}).strict();
export type BootstrapManifest = z.infer<typeof ManifestSchema>;

export async function containedFile(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file: ' + name);
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('File escapes checkout');
  return actual;
}

export async function readBootstrapManifest(root: string, code: string): Promise<BootstrapManifest> {
  const path = await containedFile(root, 'excubitor.bootstrap.json');
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (manifest.service !== code) throw new Error('Bootstrap service identity mismatch');
  // Validate all lifecycle entrypoints before any setup side effect.
  for (const script of [manifest.setup, manifest.data.export, manifest.data.import]) await containedFile(root, script);
  return manifest;
}
