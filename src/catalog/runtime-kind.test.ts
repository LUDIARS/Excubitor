import { describe, expect, it } from 'vitest';
import {
  isCommandRuntime,
  isDockerRuntime,
  isLocalProcessRuntime,
  needsWorkingDirectory,
} from './runtime-kind.js';

describe('runtime classification', () => {
  it('treats python like node for local process management', () => {
    for (const runtime of ['node', 'python', 'dev-process-md', 'app']) {
      expect(isLocalProcessRuntime(runtime)).toBe(true);
    }
    for (const runtime of ['docker', 'docker-compose', 'android']) {
      expect(isLocalProcessRuntime(runtime)).toBe(false);
    }
  });

  it('routes node and python through the cwd + command spawn path', () => {
    expect(isCommandRuntime('node')).toBe(true);
    expect(isCommandRuntime('python')).toBe(true);
    // app は exec を絶対パスで持ち、 dev-process-md は dev-process.md から解決する。
    expect(isCommandRuntime('app')).toBe(false);
    expect(isCommandRuntime('dev-process-md')).toBe(false);
  });

  it('requires a working directory for every runtime except app', () => {
    expect(needsWorkingDirectory('python')).toBe(true);
    expect(needsWorkingDirectory('node')).toBe(true);
    expect(needsWorkingDirectory('dev-process-md')).toBe(true);
    expect(needsWorkingDirectory('app')).toBe(false);
    expect(needsWorkingDirectory('docker')).toBe(false);
  });

  it('classifies container runtimes separately', () => {
    expect(isDockerRuntime('docker')).toBe(true);
    expect(isDockerRuntime('docker-compose')).toBe(true);
    expect(isDockerRuntime('node')).toBe(false);
  });
});
