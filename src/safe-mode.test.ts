import { describe, it, expect } from 'vitest';
import { detectSafeMode, setSafeMode, isSafeMode } from './safe-mode.js';

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

describe('set/isSafeMode', () => {
  it('set した値を読み出せる', () => {
    setSafeMode(true);
    expect(isSafeMode()).toBe(true);
    setSafeMode(false);
    expect(isSafeMode()).toBe(false);
  });
});
