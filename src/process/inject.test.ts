import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { vestigiumEnvFor } from './inject.js';
import { sharedLogsRoot } from '../log/logs-root.js';

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
