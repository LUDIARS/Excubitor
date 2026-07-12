import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs, { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _activeProcessLogs, processLogFile, startProcessLog, stopProcessLog } from './process-file.js';

const temporaryDirectories: string[] = [];
const originalLogDir = process.env.EXCUBITOR_PROCESS_LOG_DIR;

afterEach(async () => {
  for (const code of _activeProcessLogs()) stopProcessLog(code);
  if (originalLogDir === undefined) delete process.env.EXCUBITOR_PROCESS_LOG_DIR;
  else process.env.EXCUBITOR_PROCESS_LOG_DIR = originalLogDir;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('detached process log files', () => {
  it('owns append descriptors without starting a supervisor-side tail or buffer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'excubitor-process-file-test-'));
    temporaryDirectories.push(directory);
    process.env.EXCUBITOR_PROCESS_LOG_DIR = directory;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const handles = startProcessLog('high-volume-service');
    writeSync(handles.stdoutFd, Buffer.from('x'.repeat(1024 * 1024)));
    writeSync(handles.stderrFd, Buffer.from('error without newline'));
    stopProcessLog('high-volume-service');

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(_activeProcessLogs()).not.toContain('high-volume-service');
    expect((await readFile(processLogFile('high-volume-service', 'stdout'))).byteLength).toBe(1024 * 1024);
    expect(await readFile(processLogFile('high-volume-service', 'stderr'), 'utf8')).toBe('error without newline');
  });

  it('closes stdout when opening stderr fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'excubitor-process-file-failure-'));
    temporaryDirectories.push(directory);
    process.env.EXCUBITOR_PROCESS_LOG_DIR = directory;
    const stdoutFd = fs.openSync(join(directory, 'owned-stdout.log'), 'a');
    const open = vi.spyOn(fs, 'openSync');
    open.mockReturnValueOnce(stdoutFd);
    open.mockImplementationOnce(() => { throw new Error('stderr open failed'); });
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => startProcessLog('partial-open')).toThrow('stderr open failed');

    expect(close).toHaveBeenCalledWith(stdoutFd);
    expect(_activeProcessLogs()).not.toContain('partial-open');
  });
});
