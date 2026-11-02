/** 組み立て済みバンドル dir を zip にする。追加依存なし。 */
import { dirname, basename, resolve } from 'node:path';
import { defaultArchiveRunner, type ArchiveRunner, type ArchiveRunOptions } from './archive-runner.js';

export interface ArchiveResult {
  ok: boolean;
  zipPath: string;
  stderr: string;
}

export interface ArchiveCommand {
  cmd: string;
  args: string[];
  options: ArchiveRunOptions;
}

export function createArchiveCommand(bundleDir: string, zipPath: string, platform: string): ArchiveCommand {
  const source = resolve(bundleDir);
  const destination = resolve(zipPath);
  const options: ArchiveRunOptions = {
    cwd: dirname(source), shell: false, windowsHide: true, timeout: 600000, encoding: 'utf8',
  };
  if (platform === 'win32') {
    // Paths remain data, including quotes and wildcard characters. Preserve the contents-only layout.
    const script = "$ErrorActionPreference = 'Stop'; $paths = @(Get-ChildItem -LiteralPath $env:EXCUBITOR_ARCHIVE_SOURCE -Force | ForEach-Object { $_.FullName }); Compress-Archive -LiteralPath $paths -DestinationPath $env:EXCUBITOR_ARCHIVE_DESTINATION -Force";
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script], options: {
      ...options, env: { ...process.env, EXCUBITOR_ARCHIVE_SOURCE: source, EXCUBITOR_ARCHIVE_DESTINATION: destination },
    } };
  }
  return { cmd: 'zip', args: ['-rq', destination, '--', basename(source)], options };
}

export async function archiveBundle(
  bundleDir: string, zipPath: string,
  runner: ArchiveRunner = defaultArchiveRunner,
  platform: string = process.platform,
): Promise<ArchiveResult> {
  const command = createArchiveCommand(bundleDir, zipPath, platform);
  const r = await runner(command.cmd, command.args, command.options);
  return { ok: r.ok, zipPath, stderr: r.ok ? '' : r.stderr.slice(-2000) };
}
