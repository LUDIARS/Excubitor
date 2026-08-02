import { describe, it, expect } from 'vitest';
import {
  detectSafeMode,
  detectServiceMode,
  setSafeMode,
  isSafeMode,
  detectLogSafeMode,
  setLogSafeMode,
  isLogSafeMode,
} from './safe-mode.js';

describe('detectSafeMode', () => {
  it('EXCUBITOR_SAFE_MODE=1 で true', () => {
    expect(detectSafeMode({ EXCUBITOR_SAFE_MODE: '1' }, [])).toBe(true);
  });

  it('--safe 引数で true', () => {
    expect(detectSafeMode({}, ['node', 'server.js', '--safe'])).toBe(true);
  });

  it('未指定なら false', () => {
    expect(detectSafeMode({}, ['node', 'server.js'])).toBe(false);
  });

  it('EXCUBITOR_SAFE_MODE=0 など 1 以外は false', () => {
    expect(detectSafeMode({ EXCUBITOR_SAFE_MODE: '0' }, [])).toBe(false);
    expect(detectSafeMode({ EXCUBITOR_SAFE_MODE: 'true' }, [])).toBe(false);
  });
});

describe('detectServiceMode', () => {
  it('service mode overrides safe mode', () => {
    expect(detectServiceMode({ EXCUBITOR_SERVICE_MODE: '1' }, [])).toBe(true);
    expect(detectServiceMode({}, ['node', 'server.js', '--service'])).toBe(true);
    expect(detectSafeMode({ EXCUBITOR_SAFE_MODE: '1', EXCUBITOR_SERVICE_MODE: '1' }, [])).toBe(false);
    expect(detectSafeMode({}, ['node', 'server.js', '--safe', '--service'])).toBe(false);
  });
});

describe('set/isSafeMode', () => {
  it('set した値を読み出せる', () => {
    setSafeMode(true);
    expect(isSafeMode()).toBe(true);
    setSafeMode(false);
    expect(isSafeMode()).toBe(false);
  });
});

describe('detectLogSafeMode', () => {
  it('EXCUBITOR_LOG_SAFE_MODE=1 で true', () => {
    expect(detectLogSafeMode({ EXCUBITOR_LOG_SAFE_MODE: '1' }, [])).toBe(true);
  });

  it('--no-logs 引数で true', () => {
    expect(detectLogSafeMode({}, ['node', 'server.js', '--no-logs'])).toBe(true);
  });

  it('未指定 / 1 以外は false', () => {
    expect(detectLogSafeMode({}, ['node', 'server.js'])).toBe(false);
    expect(detectLogSafeMode({ EXCUBITOR_LOG_SAFE_MODE: '0' }, [])).toBe(false);
    expect(detectLogSafeMode({ EXCUBITOR_LOG_SAFE_MODE: 'true' }, [])).toBe(false);
  });

  it('service mode でも無効化されない (通常運用のまま切れる独立フラグ)', () => {
    expect(detectLogSafeMode({ EXCUBITOR_LOG_SAFE_MODE: '1', EXCUBITOR_SERVICE_MODE: '1' }, [])).toBe(true);
  });
});

describe('set/isLogSafeMode', () => {
  it('set した値を読み出せる', () => {
    setLogSafeMode(true);
    expect(isLogSafeMode()).toBe(true);
    setLogSafeMode(false);
    expect(isLogSafeMode()).toBe(false);
  });
});
