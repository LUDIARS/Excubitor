import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { defaultArchiveRunner } from './archive-runner.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('archive process runner', () => {
  beforeEach(() => { vi.mocked(execFile).mockReset(); });
  it.each([null, Object.assign(new Error('not found'), { code: 'ENOENT' }), Object.assign(new Error('zip failed'), { code: 2 })])('collects completion %j', async (error) => {
    // Only the callback boundary is exercised; no archiver process runs.
    vi.mocked(execFile).mockImplementation((_cmd: unknown, _args: unknown, _options: unknown, callback: unknown) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(error, 'output', '');
      return {} as ReturnType<typeof execFile>;
    });
    const options = { cwd: '.', shell: false as const, encoding: 'utf8' as const, timeout: 600000, windowsHide: false };
    const result = await defaultArchiveRunner('zip', ['-rq', 'output.zip', '--', 'bundle'], options);
    expect(execFile).toHaveBeenCalledWith('zip', ['-rq', 'output.zip', '--', 'bundle'], {
      ...options, shell: false, windowsHide: true,
    }, expect.any(Function));
    expect(result).toEqual({ ok: error === null, code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      stdout: 'output', stderr: error?.message ?? '' });
  });
});
