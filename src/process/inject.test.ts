import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { vestigiumEnvFor, arsRootEnvFor } from './inject.js';
import { sharedLogsRoot } from '../log/logs-root.js';
import { arsRoot } from '../shared/roots.js';

describe('vestigiumEnvFor', () => {
  it('log_path (<root>/<code>) の親を VESTIGIUM_LOGS_DIR にする', () => {
    // service 側 Vestigium は <root>/<code>/ に書くので、 root を渡せば file-tail が拾える。
    expect(vestigiumEnvFor({ log_path: 'E:/Document/Ars/logs/cernere' })).toEqual({
      VESTIGIUM_LOGS_DIR: path.dirname('E:/Document/Ars/logs/cernere'),
    });
  });

  it('log_path 未設定でも共有ルートを渡す (全サービスが <root>/<code>/ に書く)', () => {
    // 旧仕様は空オブジェクトだったが、 全サービスのログを file-tail に拾わせるため
    // log_path が無くても sharedLogsRoot() を注入する。
    expect(vestigiumEnvFor({})).toEqual({ VESTIGIUM_LOGS_DIR: sharedLogsRoot() });
    expect(vestigiumEnvFor({ log_path: undefined })).toEqual({ VESTIGIUM_LOGS_DIR: sharedLogsRoot() });
  });
});

describe('arsRootEnvFor', () => {
  const saved = { EXCUBITOR_ARS_ROOT: process.env.EXCUBITOR_ARS_ROOT, LUDIARS_ROOT: process.env.LUDIARS_ROOT };
  afterEach(() => {
    process.env.EXCUBITOR_ARS_ROOT = saved.EXCUBITOR_ARS_ROOT;
    process.env.LUDIARS_ROOT = saved.LUDIARS_ROOT;
  });

  it('arsRoot() を LUDIARS_ROOT として渡す (子サービスの作業ディレクトリ基準)', () => {
    process.env.EXCUBITOR_ARS_ROOT = 'D:\\LUDIARS\\';
    // 末尾スラッシュ除去 + forward-slash 正規化された arsRoot() と一致する。
    expect(arsRootEnvFor()).toEqual({ LUDIARS_ROOT: arsRoot() });
    expect(arsRootEnvFor()).toEqual({ LUDIARS_ROOT: 'D:/LUDIARS' });
  });

  it('ドライブを焼き込まない (env でルートが切り替わる)', () => {
    delete process.env.EXCUBITOR_ARS_ROOT;
    process.env.LUDIARS_ROOT = 'E:/Document/Ars';
    expect(arsRootEnvFor()).toEqual({ LUDIARS_ROOT: 'E:/Document/Ars' });
  });
});
