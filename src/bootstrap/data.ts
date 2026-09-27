import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { directory } from './checkout.js';
import { containedFile, type BootstrapManifest } from './manifest.js';
import { runBootstrapHook } from './hook.js';
import { DataOptionsSchema } from './options.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
async function transferDirectory(code: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(code)) throw new Error('Invalid service code for transfer');
  let path = await directory(resolve(process.cwd()));
  for (const part of ['data', 'transfers', code]) {
    path = join(path, part);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await directory(path);
  }
  return path;
}

export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  try { for await (const chunk of stream) hash.update(chunk); } finally { stream.destroy(); }
  return hash.digest('hex');
}

export async function migrateData(root: string, manifest: BootstrapManifest, action: 'data-export' | 'data-import', raw: unknown): Promise<string> {
  const options = DataOptionsSchema.parse(raw);
  const configured = process.env.EXCUBITOR_TAILDROP_DIR ?? join(homedir(), 'taildrop');
  if (action === 'data-import' && !isAbsolute(configured)) throw new Error('EXCUBITOR_TAILDROP_DIR must be absolute');
  const transfers = action === 'data-export' ? await transferDirectory(manifest.service) : await directory(configured);
  const name = options.artifact + '.bundle';
  const path = join(transfers, name);
  if (action === 'data-export') {
    try {
      await lstat(path);
      throw new Error('Export artifact already exists; use a new artifact identifier');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await runBootstrapHook(root, manifest.data.export, ['--output', path]);
    await containedFile(transfers, name);
    await chmod(path, 0o600);
    return 'artifact=' + options.artifact + ' sha256=' + await fileHash(path);
  }
  if (!options.sha256) throw new Error('Import requires expected sha256 from the source export');
  await containedFile(transfers, name);
  if (await fileHash(path) !== options.sha256) throw new Error('Transfer checksum mismatch');
  await runBootstrapHook(root, manifest.data.import, ['--input', path, '--sha256', options.sha256]);
  return 'Imported artifact=' + options.artifact;
}
