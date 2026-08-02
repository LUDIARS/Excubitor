import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fs, { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _activeProcessLogs, processLogFile, startProcessLog, stopProcessLog } from './process-file.js';

const temporaryDirectories: string[] = [];
const originalLogDir = process.env.EXCUBITOR_PROCESS_LOG_DIR;
const originalMaxMb = process.env.EXCUBITOR_PROCESS_LOG_MAX_MB;

// 「ローテーションしない」 系は既定上限 (32MB) を前提にするため、 ambient の上限設定から隔離する。
beforeEach(() => {
  delete process.env.EXCUBITOR_PROCESS_LOG_MAX_MB;
});

afterEach(async () => {
  for (const code of _activeProcessLogs()) stopProcessLog(code);
  if (originalLogDir === undefined) delete process.env.EXCUBITOR_PROCESS_LOG_DIR;
  else process.env.EXCUBITOR_PROCESS_LOG_DIR = originalLogDir;
  if (originalMaxMb === undefined) delete process.env.EXCUBITOR_PROCESS_LOG_MAX_MB;
  else process.env.EXCUBITOR_PROCESS_LOG_MAX_MB = originalMaxMb;
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

  it('上限超過のログは open 時に .1 へローテーションする', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'excubitor-process-file-rotate-'));
    temporaryDirectories.push(directory);
    process.env.EXCUBITOR_PROCESS_LOG_DIR = directory;
    process.env.EXCUBITOR_PROCESS_LOG_MAX_MB = '0.001'; // 1KB

    const first = startProcessLog('rotating-service');
    writeSync(first.stdoutFd, Buffer.from('x'.repeat(4096)));
    stopProcessLog('rotating-service');

    startProcessLog('rotating-service');
    stopProcessLog('rotating-service');

    const current = await readFile(processLogFile('rotating-service', 'stdout'));
    const archived = await readFile(`${processLogFile('rotating-service', 'stdout')}.1`);
    expect(current.byteLength).toBe(0);
    expect(archived.byteLength).toBe(4096);
  });

  it('ログ dir の外を指す code はローテーションせず .1 を消さない', async () => {
    // catalog の code は未検証。 `../` 入りでも rm/rename がログ dir 外へ届いてはならない。
    const base = await mkdtemp(join(tmpdir(), 'excubitor-process-file-escape-'));
    temporaryDirectories.push(base);
    const directory = join(base, 'logs');
    fs.mkdirSync(directory);
    process.env.EXCUBITOR_PROCESS_LOG_DIR = directory;
    process.env.EXCUBITOR_PROCESS_LOG_MAX_MB = '0.001'; // 1KB

    const escaped = processLogFile('../victim', 'stdout');
    expect(escaped).toBe(join(base, 'victim.out.log'));
    fs.writeFileSync(escaped, 'x'.repeat(4096));
    fs.writeFileSync(`${escaped}.1`, 'pre-existing bystander');

    startProcessLog('../victim');
    stopProcessLog('../victim');

    expect(await readFile(`${escaped}.1`, 'utf8')).toBe('pre-existing bystander');
    expect((await readFile(escaped)).byteLength).toBe(4096);
  });

  it('上限以下のログはローテーションしない', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'excubitor-process-file-keep-'));
    temporaryDirectories.push(directory);
    process.env.EXCUBITOR_PROCESS_LOG_DIR = directory;
    const first = startProcessLog('small-service');
    writeSync(first.stdoutFd, Buffer.from('small'));
    stopProcessLog('small-service');

    startProcessLog('small-service');
    stopProcessLog('small-service');

    expect(await readFile(processLogFile('small-service', 'stdout'), 'utf8')).toBe('small');
    expect(fs.existsSync(`${processLogFile('small-service', 'stdout')}.1`)).toBe(false);
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
