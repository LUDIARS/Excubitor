import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { vestigiumEnvFor } from './inject.js';

describe('vestigiumEnvFor', () => {
  it('log_path (<root>/<code>) の親を VESTIGIUM_LOGS_DIR にする', () => {
    // service 側 Vestigium は <root>/<code>/ に書くので、 root を渡せば file-tail (log_path) と一致する。
    expect(vestigiumEnvFor({ log_path: 'E:/Document/Ars/logs/cernere' })).toEqual({
      VESTIGIUM_LOGS_DIR: path.dirname('E:/Document/Ars/logs/cernere'),
    });
  });

  it('log_path 未設定なら空 (サービスは自分の cwd/logs を既定にする)', () => {
    expect(vestigiumEnvFor({})).toEqual({});
    expect(vestigiumEnvFor({ log_path: undefined })).toEqual({});
  });
});
