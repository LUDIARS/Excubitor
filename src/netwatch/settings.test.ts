/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { NETWATCH_INTERFACE_ENV, NETWATCH_TSHARK_ENV, resolveNetwatchSettings } from './settings.js';
import { DEFAULT_CAPTURE_FILTER } from './tshark-command.js';

function catalog(netwatch: Partial<Catalog['netwatch']> = {}): Catalog {
  return {
    netwatch: {
      enabled: true,
      capture_filter: '',
      name_resolution: 'g',
      home_country: 'JP',
      max_destinations: 100,
      dns_ttl_sec: 600,
      restart_after_min: 60,
      retry_after_sec: 30,
      overlay: { file: 'data/netwatch/overlay.telalist', max_rows: 12, include: 'public', interval_sec: 2 },
      detect: { owner_poll_sec: 2, allowed_ports: [53, 80, 443, 853], trusted_domains: [] },
      ...netwatch,
    },
  } as Catalog;
}

const cwd = resolve('/work/excubitor');

describe('resolveNetwatchSettings', () => {
  it('interface の env が無い拠点ではキャプチャしない', () => {
    const resolved = resolveNetwatchSettings(catalog(), {}, cwd);
    expect(resolved.capture).toBeNull();
    expect(resolved.disabledReason).toBe(`${NETWATCH_INTERFACE_ENV} 未設定`);
    expect(resolved.overlay.file).toBe(resolve(cwd, 'data/netwatch/overlay.telalist'));
  });

  it('enabled=false なら env があっても止める', () => {
    const resolved = resolveNetwatchSettings(catalog({ enabled: false }), { [NETWATCH_INTERFACE_ENV]: 'Wi-Fi' }, cwd);
    expect(resolved.disabledReason).toBe('netwatch.enabled=false');
  });

  it('env からインタフェースと tshark を取り、 既定のフィルタを使う', () => {
    const resolved = resolveNetwatchSettings(
      catalog(),
      { [NETWATCH_INTERFACE_ENV]: ' Wi-Fi ', [NETWATCH_TSHARK_ENV]: 'C:/Wireshark/tshark.exe' },
      cwd,
    );
    expect(resolved.capture?.executable).toBe('C:/Wireshark/tshark.exe');
    expect(resolved.capture?.args.slice(0, 2)).toEqual(['-i', 'Wi-Fi']);
    expect(resolved.capture?.args[resolved.capture.args.indexOf('-f') + 1]).toBe(DEFAULT_CAPTURE_FILTER);
    expect(resolved.capture).toMatchObject({ dnsTtlMs: 600_000, restartAfterMs: 3_600_000, retryAfterMs: 30_000 });
  });

  it('tshark の env が無ければ PATH 上の tshark', () => {
    const resolved = resolveNetwatchSettings(catalog(), { [NETWATCH_INTERFACE_ENV]: '1' }, cwd);
    expect(resolved.capture?.executable).toBe('tshark');
  });

  it('外部 DNS を使う名前解決は設定エラーとして投げる', () => {
    expect(() => resolveNetwatchSettings(catalog({ name_resolution: 'gn' }), { [NETWATCH_INTERFACE_ENV]: '1' }, cwd))
      .toThrow(/name_resolution/);
  });

  it('一覧ファイルが空なら書かない', () => {
    const resolved = resolveNetwatchSettings(
      catalog({ overlay: { file: '', max_rows: 5, include: 'foreign', interval_sec: 3 } }),
      {},
      cwd,
    );
    expect(resolved.overlay).toEqual({ file: null, maxRows: 5, include: 'foreign', intervalMs: 3_000 });
  });

  it('検知の設定はキャプチャしない拠点でも返し、 信頼ドメインは小文字・末尾ドットなしにする', () => {
    const resolved = resolveNetwatchSettings(
      catalog({ detect: { owner_poll_sec: 5, allowed_ports: [443, 22], trusted_domains: [' GitHub.com. ', ''] } }),
      {},
      cwd,
    );
    expect(resolved.detect.ownerPollMs).toBe(5_000);
    expect([...resolved.detect.allowedPorts]).toEqual([443, 22]);
    expect(resolved.detect.trustedDomains).toEqual(['github.com']);
  });
});
