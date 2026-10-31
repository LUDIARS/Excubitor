/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { defaultStatusFile, resolveBlockSettings } from './block-settings.js';

type BlockConfig = Catalog['netwatch']['block'];

function catalog(block: Partial<BlockConfig> = {}): Catalog {
  return {
    netwatch: {
      block: {
        enabled: true, file: 'data/netwatch/firewall-blocks.json', status_file: '', max_entries: 256,
        default_ttl_min: 60, max_ttl_min: 10_080, protected_addresses: [] as string[], protected_programs: [] as string[],
        ...block,
      },
    },
  } as unknown as Catalog;
}

const cwd = resolve('/work/excubitor');
const windows = { env: { ProgramData: 'C:\\ProgramData' }, cwd, platform: 'win32' as const, ownPrograms: [] };

describe('resolveBlockSettings', () => {
  it('Windows では遮断ファイルを cwd から、 状態ファイルを ProgramData から決める', () => {
    const resolved = resolveBlockSettings(catalog(), windows);
    expect(resolved.settings).toMatchObject({
      file: resolve(cwd, 'data/netwatch/firewall-blocks.json'),
      statusFile: resolve(cwd, defaultStatusFile('C:\\ProgramData')),
      maxEntries: 256, defaultTtlMs: 3_600_000, maxTtlMs: 604_800_000,
    });
    expect(defaultStatusFile('C:\\ProgramData')).toBe(join('C:\\ProgramData', 'Excubitor', 'netwatch-firewall', 'status.json'));
  });

  it('無効・Windows 以外・ProgramData が無いときは理由を返す', () => {
    expect(resolveBlockSettings(catalog({ enabled: false }), windows).disabledReason).toBe('netwatch.block.enabled=false');
    expect(resolveBlockSettings(catalog(), { ...windows, platform: 'linux' }).disabledReason).toMatch(/Windows/);
    expect(resolveBlockSettings(catalog(), { ...windows, env: {} }).disabledReason).toMatch(/ProgramData/);
  });

  it('既定の期限が上限を超える設定はエラー', () => {
    expect(() => resolveBlockSettings(catalog({ default_ttl_min: 100, max_ttl_min: 10 }), windows)).toThrow(/default_ttl_min/);
  });
});
