/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Service } from '../../catalog/loader.js';
import { dailyCommand } from './command.js';
import { containsPath } from './repositories.js';

/** Build all declared services, deduplicating shared Node workspaces and their frontend. */
export async function buildDailyRepository(path: string, services: Service[]): Promise<void> {
  const dirs = new Set([path, ...services.map((svc) => resolve(svc.cwd ?? path))]);
  for (const dir of [...dirs]) if (existsSync(join(dir, 'frontend', 'package.json'))) dirs.add(join(dir, 'frontend'));
  for (const dir of dirs) {
    if (!containsPath(path, dir)) throw new Error('build directory escaped repository');
    if (!existsSync(join(dir, 'package.json'))) continue;
    const locked = existsSync(join(dir, 'package-lock.json'));
    await dailyCommand('npm', [locked ? 'ci' : 'install', '--include=dev', '--no-audit', '--no-fund',
      ...(!locked ? ['--package-lock=false'] : [])], dir, 600_000, true);
  }
  const commands = new Set<string>();
  for (const svc of services) {
    if (svc.build_command) {
      const cwd = resolve(svc.cwd ?? path);
      const key = `${cwd}\n${svc.build_command}`;
      if (!commands.has(key)) await dailyCommand(svc.build_command, [], cwd, 600_000, true);
      commands.add(key);
    }
    if (svc.runtime === 'docker-compose' && svc.compose_file) {
      await dailyCommand('docker', ['compose', '-f', svc.compose_file, 'build', ...(svc.services ?? [])], path, 600_000);
    }
  }
  for (const dir of dirs) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.build) await dailyCommand('npm', ['run', 'build'], dir, 600_000, true);
  }
}
