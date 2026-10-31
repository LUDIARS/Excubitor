/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { overlaps, parseCidr } from './cidr.js';
import { buildProtectionPolicy, validateBlockTarget } from './block-target.js';

describe('parseCidr', () => {
  it('単一アドレスは prefix を付け、 範囲の途中は先頭に揃える', () => {
    expect(parseCidr('203.0.113.5')?.text).toBe('203.0.113.5/32');
    expect(parseCidr('203.0.113.77/24')?.text).toBe('203.0.113.0/24');
    expect(parseCidr('2001:DB8:0:0:1::5/64')?.text).toBe('2001:db8::/64');
    expect(parseCidr('::ffff:192.0.2.1')?.text).toBe('::ffff:c000:201/128');
  });

  it('読めない値は null', () => {
    for (const value of ['', 'example.com', '203.0.113.5/33', '203.0.113.5/24/1', 'fe80::1%12', '1.2.3.4/x']) {
      expect(parseCidr(value)).toBeNull();
    }
  });

  it('重なりは同じファミリーの範囲だけ', () => {
    expect(overlaps(parseCidr('10.1.2.3')!, parseCidr('10.0.0.0/8')!)).toBe(true);
    expect(overlaps(parseCidr('11.0.0.0/8')!, parseCidr('10.0.0.0/8')!)).toBe(false);
    expect(overlaps(parseCidr('::1')!, parseCidr('0.0.0.0/8')!)).toBe(false);
  });
});

describe('validateBlockTarget', () => {
  const policy = buildProtectionPolicy(['198.51.100.53'], ['ExcubitorHelper.exe'], ['C:\\Program Files\\nodejs\\node.exe']);

  it('公開アドレスと範囲は正規化して受ける', () => {
    expect(validateBlockTarget('address', ' 203.0.113.5 ', policy)).toEqual({ ok: true, target: { kind: 'address', value: '203.0.113.5/32' } });
    expect(validateBlockTarget('address', '203.0.113.0/24', policy)).toMatchObject({ ok: true });
  });

  it('守る範囲 (LAN・Tailscale・loopback・追加分) と重なるもの、 広すぎる範囲は拒否する', () => {
    for (const value of ['192.168.1.10', '100.100.1.1', '127.0.0.1', '::1', 'fd00::1', '198.51.100.53', '0.0.0.0/0', '8.0.0.0/7', '2001::/16']) {
      expect(validateBlockTarget('address', value, policy).ok, value).toBe(false);
    }
  });

  it('プログラムは .exe の絶対パスだけ。 守るプログラムと Excubitor 自身は拒否する', () => {
    expect(validateBlockTarget('program', 'C:\\Tools\\.\\suspicious.exe', policy))
      .toEqual({ ok: true, target: { kind: 'program', value: 'C:\\Tools\\suspicious.exe' } });
    for (const value of [
      'suspicious.exe', '\\\\server\\share\\a.exe', 'C:\\Tools\\a.bat', 'C:\\Tools\\*.exe', 'C:\\Tools\\..\\a.exe',
      'C:\\Windows\\System32\\svchost.exe', 'C:\\x\\excubitorhelper.exe', 'c:\\program files\\nodejs\\node.exe', '%TEMP%\\a.exe',
    ]) {
      expect(validateBlockTarget('program', value, policy).ok, value).toBe(false);
    }
  });

  it('読めない追加の守る範囲は設定エラー', () => {
    expect(() => buildProtectionPolicy(['dns.example'], [], [])).toThrow(/protected_addresses/);
  });
});
