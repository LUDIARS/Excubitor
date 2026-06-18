import { describe, it, expect } from 'vitest';
import { parseSize, formatBytes } from './units.js';

describe('parseSize', () => {
  it('binary 単位 (MiB/GiB) をバイトへ', () => {
    expect(parseSize('1MiB')).toBe(1024 ** 2);
    expect(parseSize('1.5GiB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('512B')).toBe(512);
  });

  it('decimal 単位 (kB/MB) をバイトへ', () => {
    expect(parseSize('1kB')).toBe(1000);
    expect(parseSize('2MB')).toBe(2_000_000);
  });

  it('空白入り・大文字小文字を許容', () => {
    expect(parseSize(' 123.4 mib ')).toBe(Math.round(123.4 * 1024 ** 2));
  });

  it('解釈不能は null', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('abc')).toBeNull();
    expect(parseSize('12XB')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('単位ごとに表示', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 ** 2 * 1.5)).toBe('1.5 MiB');
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.00 GiB');
  });
  it('null/NaN は —', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});
