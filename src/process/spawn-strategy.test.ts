import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

/** 残骸の warn は 1 プロセス 1 回なので、テストごとにモジュール状態を作り直す。 */
async function loadStrategy() {
  vi.resetModules();
  return import('./spawn-strategy.js');
}

describe('spawnsOutsideJob (design.md §17.6)', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
  });

  it('win32 は必ず Job 外で起動する', async () => {
    const { spawnsOutsideJob } = await loadStrategy();
    expect(spawnsOutsideJob('win32', {})).toBe(true);
  });

  it('POSIX は supervisor の子として起動する', async () => {
    const { spawnsOutsideJob } = await loadStrategy();
    expect(spawnsOutsideJob('linux', {})).toBe(false);
    expect(spawnsOutsideJob('darwin', {})).toBe(false);
  });

  it('廃止した EXCUBITOR_SPAWN_STRATEGY=child が残っていても win32 で child 起動に戻らない', async () => {
    // 2026-09-06 / 2026-09-19: ユーザ環境変数の child が breakaway を黙って無効にし、
    // supervisor 再起動のたびに配下サービスが Job ごと落ちた。
    const { spawnsOutsideJob, RETIRED_SPAWN_STRATEGY_ENV } = await loadStrategy();
    const env = { [RETIRED_SPAWN_STRATEGY_ENV]: 'child' };

    expect(spawnsOutsideJob('win32', env)).toBe(true);
    expect(spawnsOutsideJob('win32', env)).toBe(true);

    // 従わないことは観測できるようにする。ただし spawn のたびに流さない。
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      { env: 'EXCUBITOR_SPAWN_STRATEGY', value: 'child' },
      expect.stringContaining('retired'),
    );
  });

  it('上書き env が無ければ何も警告しない', async () => {
    const { spawnsOutsideJob } = await loadStrategy();
    spawnsOutsideJob('win32', {});
    spawnsOutsideJob('win32', { EXCUBITOR_SPAWN_STRATEGY: '' });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
