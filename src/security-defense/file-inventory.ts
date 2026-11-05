import { lstat, readdir, open, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Catalog } from '../catalog/loader.js';
import { fingerprint, type Fingerprint } from './baseline.js';

export interface Inventory { entries: Fingerprint[]; complete: boolean; errors: number }
/** Explicit small file sets; no recursive repository scan, no symlinks, no plaintext persisted. */
export async function fileInventory(catalog: Catalog, extra: string[], platform = process.platform): Promise<Inventory> {
  const targets = new Set(extra.map(p => resolve(p)));
  for (const service of catalog.services) if (service.cwd) {
    for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'excubitor.catalog.yaml']) targets.add(join(service.cwd, name));
    const entry = /^node(?:\.exe)?\s+([\w./\\-]+\.m?js)(?:\s|$)/.exec(service.command ?? '');
    if (entry?.[1]) targets.add(resolve(service.cwd, entry[1]));
  }
  targets.add(resolve('data/intrusion-config.json'));
  targets.add(resolve('data/security-defense.json'));
  targets.add(join(homedir(), '.ssh', 'authorized_keys'));
  if (platform === 'linux') {
    for (const path of ['/etc/passwd', '/etc/group', '/etc/sudoers', '/etc/sudoers.d', '/etc/ssh/sshd_config', '/etc/ssh/sshd_config.d', '/etc/crontab', '/etc/cron.d', '/etc/systemd/system']) targets.add(path);
  } else if (platform === 'win32') {
    for (const base of [process.env.APPDATA, process.env.ProgramData]) {
      if (base) targets.add(join(base, 'Microsoft/Windows/Start Menu/Programs/Startup'));
    }
  }
  const entries: Fingerprint[] = [];
  let errors = 0;
  let visited = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++visited > 4000) { errors++; return; }
    const asset = fingerprint(path); // Only the local management candidate reveals paths; daily reports use this hash.
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { entries.push({ asset, localPath: path, hash: fingerprint('symlink:' + await readlink(path)) }); return; }
      if (stat.isDirectory()) {
        if (depth >= 3) { errors++; return; }
        const children = (await readdir(path)).sort();
        entries.push({ asset, localPath: path, hash: fingerprint(JSON.stringify(children)) });
        for (const child of children.slice(0, 500)) await visit(join(path, child), depth + 1);
        if (children.length > 500) errors++;
      } else if (stat.isFile() && stat.size <= 4 * 1024 * 1024) {
        // Authorized key/private key files are fingerprinted only, never copied to logs.
        const handle = await open(path, 'r');
        try {
          const contents = Buffer.alloc(stat.size + 1);
          let size = 0;
          while (size < contents.length) {
            const read = await handle.read(contents, size, contents.length - size, null);
            if (!read.bytesRead) break;
            size += read.bytesRead;
          }
          const after = await handle.stat();
          if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino || after.dev !== stat.dev) { errors++; return; }
          entries.push({ asset, localPath: path, hash: fingerprint(Buffer.concat([Buffer.from(`${stat.mode}:${stat.uid}:${stat.gid}:`), contents.subarray(0, size)])) });
        } finally { await handle.close(); }
      } else { errors++; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries.push({ asset, localPath: path, hash: 'absent' });
      else errors++;
    }
  };
  for (const path of targets) await visit(path, 0);
  return { entries, complete: errors === 0, errors };
}
