import { describe, it, expect } from 'vitest';
import {
  parseNetstat,
  parseSs,
  parseTasklist,
  detectConcurrentDevelopConflicts,
  detectDeclaredConflicts,
} from './ports.js';
import type { Catalog } from '../catalog/loader.js';

describe('parseNetstat', () => {
  it('LISTENING 行から port と pid を取る', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:17332          0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:5180         0.0.0.0:0              LISTENING       5678',
      '  TCP    127.0.0.1:5180         127.0.0.1:50000        ESTABLISHED     9999',
      '  UDP    0.0.0.0:53             *:*                                    111',
    ].join('\r\n');
    const r = parseNetstat(out);
    expect(r).toEqual([
      { port: 17332, pid: 1234 },
      { port: 5180, pid: 5678 },
    ]);
  });

  it('IPv6 アドレス末尾の :port も取れる', () => {
    const out = '  TCP    [::]:8080              [::]:0                 LISTENING       42';
    expect(parseNetstat(out)).toEqual([{ port: 8080, pid: 42 }]);
  });
});

describe('parseSs', () => {
  it('users:(("name",pid=N)) から pid を取る', () => {
    const out = 'LISTEN 0 511 0.0.0.0:17332 0.0.0.0:* users:(("node",pid=4321,fd=20))';
    expect(parseSs(out)).toEqual([{ port: 17332, pid: 4321 }]);
  });

  it('pid 不明でも port は取れる (-1)', () => {
    const out = 'LISTEN 0 511 *:3000 *:*';
    expect(parseSs(out)).toEqual([{ port: 3000, pid: -1 }]);
  });
});

describe('parseTasklist', () => {
  it('csv 行を pid→name に解析する', () => {
    const out = '"node.exe","1234","Console","1","120,000 K"\r\n"chrome.exe","5678","Console","1","80 K"';
    const m = parseTasklist(out);
    expect(m.get(1234)).toBe('node.exe');
    expect(m.get(5678)).toBe('chrome.exe');
  });
});

describe('detectDeclaredConflicts', () => {
  const mk = (code: string, port?: number, extra: Partial<Catalog['services'][number]> = {}): Catalog['services'][number] =>
    ({ code, name: code, runtime: 'node', port, monitor_only: false, autostart: false,
       develop_derived: false,
       ...extra,
       restart_policy: 'no', max_restart: 5 } as Catalog['services'][number]);

  it('同一 port を宣言する複数サービスを検出する', () => {
    const catalog = { services: [mk('a', 3000), mk('b', 3000), mk('c', 4000)], memory_monitor: {} } as unknown as Catalog;
    const conflicts = detectDeclaredConflicts(catalog);
    expect(conflicts).toEqual([{ port: 3000, codes: ['a:service', 'b:service'] }]);
  });

  it('port 未宣言は無視する', () => {
    const catalog = { services: [mk('a'), mk('b')], memory_monitor: {} } as unknown as Catalog;
    expect(detectDeclaredConflicts(catalog)).toEqual([]);
  });

  it('同じ project_code の正規 main/develop ペアは衝突から除外する', () => {
    const catalog = { services: [
      mk('concordia', 11111, { project_code: 'concordia' }),
      mk('concordia-develop', 11111, {
        project_code: 'concordia',
        develop_derived: true,
        develop_from: 'concordia',
      }),
    ], memory_monitor: {} } as unknown as Catalog;
    expect(detectDeclaredConflicts(catalog)).toEqual([]);
  });

  it('develop suffix だけ、または別 project の重複は衝突として残す', () => {
    const catalog = { services: [
      mk('a', 3000, { project_code: 'a' }),
      mk('a-develop', 3000, { project_code: 'a' }),
      mk('b-develop', 4000, { project_code: 'b', develop_derived: true, develop_from: 'b' }),
      mk('c', 4000, { project_code: 'c' }),
    ], memory_monitor: {} } as unknown as Catalog;
    expect(detectDeclaredConflicts(catalog)).toEqual([
      { port: 3000, codes: ['a:service', 'a-develop:service'] },
      { port: 4000, codes: ['b-develop:service', 'c:service'] },
    ]);
  });

  it('main/develop ペアが共に running かつ LISTEN 中なら実行時衝突にする', () => {
    const catalog = { services: [
      mk('concordia', 11111, { project_code: 'concordia' }),
      mk('concordia-develop', 11111, {
        project_code: 'concordia',
        develop_derived: true,
        develop_from: 'concordia',
      }),
    ], memory_monitor: {} } as unknown as Catalog;
    const states = new Map([['concordia', 'running'], ['concordia-develop', 'running']]);

    expect([...detectConcurrentDevelopConflicts(catalog, states, new Set([11111]))]).toEqual([
      'concordia:service',
      'concordia-develop:service',
    ]);
    expect(detectConcurrentDevelopConflicts(catalog, states, new Set())).toEqual(new Set());
  });
});
