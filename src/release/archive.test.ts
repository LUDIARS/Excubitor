import { describe, expect, it, vi } from 'vitest';
import { basename, dirname, resolve } from 'node:path';
import { archiveBundle } from './archive.js';
import type { ArchiveRunner } from './archive-runner.js';

describe('archiveBundle', () => {
  const bundle = resolve("parent ' ; $()/bundle [literal]");
  const destination = resolve("out ' ; $()/archive [literal].zip");
  it.each(['linux', 'darwin'])('uses zip argv on %s', async (platform) => {
    const runner = vi.fn<ArchiveRunner>().mockResolvedValue({ ok: true, code: 0, stdout: '', stderr: '' });
    expect(await archiveBundle(bundle, destination, runner, platform)).toEqual({ ok: true, zipPath: destination, stderr: '' });
    expect(runner).toHaveBeenCalledWith('zip', ['-rq', destination, '--', basename(bundle)], expect.objectContaining({ cwd: dirname(bundle), shell: false, windowsHide: true }));
  });
  it('passes Windows paths as environment data and uses literal child paths', async () => {
    const runner = vi.fn<ArchiveRunner>().mockResolvedValue({ ok: true, code: 0, stdout: '', stderr: '' });
    await archiveBundle(bundle, destination, runner, 'win32');
    const [cmd, args, options] = runner.mock.calls[0]!;
    expect(cmd).toBe('powershell');
    expect(options).toMatchObject({ cwd: dirname(bundle), shell: false, windowsHide: true, env: {
      EXCUBITOR_ARCHIVE_SOURCE: bundle, EXCUBITOR_ARCHIVE_DESTINATION: destination,
    } });
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command', expect.any(String)]);
    expect(args[3]).toContain('-LiteralPath $env:EXCUBITOR_ARCHIVE_SOURCE');
    expect(args[3]).toContain('-LiteralPath $paths');
    expect(args[3]).not.toContain(bundle);
    expect(args[3]).not.toContain(destination);
  });
  it('keeps archive failures and truncates stderr', async () => {
    const runner: ArchiveRunner = async () => ({ ok: false, code: 1, stdout: '', stderr: 'x'.repeat(3000) });
    expect(await archiveBundle(bundle, destination, runner, 'linux')).toEqual({ ok: false, zipPath: destination, stderr: 'x'.repeat(2000) });
  });
});
