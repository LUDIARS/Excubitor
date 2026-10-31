import { mkdtempSync, writeFileSync, renameSync, openSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installRealConfigWriteGuard, isInsideAny, realExcubitorDirs } from './real-config-guard.js';

describe('real config write guard', () => {
  it('derives the real dir from APPDATA / XDG and explicit overrides', () => {
    expect(realExcubitorDirs({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })[0]).toMatch(/Excubitor$/);
    expect(realExcubitorDirs({ XDG_CONFIG_HOME: '/home/u/.config', EXCUBITOR_MASTER_KEY_DIR: '/keys' })).toHaveLength(2);
  });

  it('matches paths inside the dir only (case-insensitive on win32)', () => {
    expect(isInsideAny('C:\\A\\Excubitor\\config.enc', ['c:\\a\\excubitor'], 'win32')).toBe(true);
    expect(isInsideAny('/a/Excubitor-other/config.enc', ['/a/Excubitor'], 'linux')).toBe(false);
  });

  it('the setup points every config path at a temp dir', () => {
    for (const key of ['APPDATA', 'EXCUBITOR_CONFIG_PATH', 'EXCUBITOR_MASTER_KEY_DIR', 'EXCUBITOR_MESH_TOKEN_PATH', 'EXCUBITOR_AGENT_TOKEN_PATH']) {
      expect(isInsideAny(process.env[key]!, [tmpdir()]), key).toBe(true);
    }
    expect(process.env.EXCUBITOR_MASTER_KEY).toBeUndefined();
  });

  it('refuses writes into a guarded dir and leaves other paths alone', async () => {
    const guarded = mkdtempSync(join(tmpdir(), 'ex-guarded-'));
    const free = mkdtempSync(join(tmpdir(), 'ex-free-'));
    installRealConfigWriteGuard([guarded]);
    expect(() => writeFileSync(join(guarded, 'config.enc'), 'x')).toThrow(/test guard/);
    writeFileSync(join(free, 'a'), 'x');
    expect(() => renameSync(join(free, 'a'), join(guarded, 'config.enc'))).toThrow(/test guard/);
    expect(() => openSync(join(guarded, 'config.enc'), 'w')).toThrow(/test guard/);
    await expect(writeFile(join(guarded, 'config.enc'), 'x')).rejects.toThrow(/test guard/);
    expect(readFileSync(join(free, 'a'), 'utf8')).toBe('x');
  });
});
