import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFileTail, _tailingCodes, type FileTailHandle } from './file-tail.js';
import type { Catalog } from '../catalog/loader.js';

const emptyCatalog: Catalog = { services: [] } as unknown as Catalog;

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extail-'));
  return root;
}

describe('file-tail auto-discovery', () => {
  let prevEnv: string | undefined;
  let handle: FileTailHandle | null = null;
  let root: string;

  beforeEach(() => {
    prevEnv = process.env.VESTIGIUM_LOGS_DIR;
    root = mkRoot();
    process.env.VESTIGIUM_LOGS_DIR = root;
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    if (prevEnv === undefined) delete process.env.VESTIGIUM_LOGS_DIR;
    else process.env.VESTIGIUM_LOGS_DIR = prevEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('共有ルート配下の <code>/ を catalog 設定なしで tail 対象にする', () => {
    fs.mkdirSync(path.join(root, 'cernere'));
    fs.mkdirSync(path.join(root, 'memoria'));
    fs.writeFileSync(path.join(root, 'not-a-dir.txt'), 'x'); // ディレクトリ以外は無視

    handle = startFileTail(emptyCatalog);

    const codes = _tailingCodes().sort();
    expect(codes).toContain('cernere');
    expect(codes).toContain('memoria');
    expect(codes).not.toContain('not-a-dir.txt');
  });

  it('catalog の log_path は共有ルート外でも tail する', () => {
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'excustom-'));
    const catalog = {
      services: [{ code: 'special', log_path: path.join(custom, 'special') }],
    } as unknown as Catalog;

    handle = startFileTail(catalog);

    expect(_tailingCodes()).toContain('special');
    fs.rmSync(custom, { recursive: true, force: true });
  });
});
