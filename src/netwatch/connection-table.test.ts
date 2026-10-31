/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { ConnectionTable, parseNetstat } from './connection-table.js';

// 日本語版 Windows の見出し・状態名でも列の形だけで読めること。
const NETSTAT = [
  '',
  'アクティブな接続',
  '',
  '  プロトコル  ローカル アドレス      外部アドレス           状態            PID',
  '  TCP         0.0.0.0:135            0.0.0.0:0              LISTENING       1100',
  '  TCP         192.168.1.10:51234     203.0.113.5:443        ESTABLISHED     4242',
  '  TCP         192.168.1.10:51235     203.0.113.6:443        SYN_SENT        4242',
  '  TCP         192.168.1.10:51236     203.0.113.7:443        TIME_WAIT       0',
  '  TCP         [2001:db8::10]:51300   [2001:db8::1]:443      ESTABLISHED     5151',
  '  TCP         [fe80::1%12]:51400     [fe80::2%12]:22        ESTABLISHED     6000',
  '  UDP         0.0.0.0:61000          *:*                                    7777',
  '  UDP         [::]:61001             *:*                                    7778',
  '  UDP         0.0.0.0:5353           *:*                                    8000',
  '  UDP         0.0.0.0:5353           *:*                                    8001',
].join('\r\n');

describe('parseNetstat', () => {
  it('見出しと PID 0 を飛ばし、 TCP は相手つき、 UDP は相手なしで読む', () => {
    const entries = parseNetstat(NETSTAT);
    expect(entries).toContainEqual({ transport: 'tcp', localPort: 51234, remote: '203.0.113.5', pid: 4242 });
    expect(entries).toContainEqual({ transport: 'tcp', localPort: 135, remote: null, pid: 1100 });
    expect(entries).toContainEqual({ transport: 'tcp', localPort: 51300, remote: '2001:db8::1', pid: 5151 });
    expect(entries).toContainEqual({ transport: 'tcp', localPort: 51400, remote: 'fe80::2', pid: 6000 });
    expect(entries).toContainEqual({ transport: 'udp', localPort: 61001, remote: null, pid: 7778 });
    expect(entries.some((entry) => entry.pid === 0)).toBe(false);
    expect(entries).toHaveLength(9);
  });
});

describe('ConnectionTable.ownerOf', () => {
  const table = new ConnectionTable(parseNetstat(NETSTAT));

  it('TCP はポートと相手で引く', () => {
    expect(table.ownerOf({ transport: 'tcp', port: 51234 }, '203.0.113.5')).toBe(4242);
    expect(table.ownerOf({ transport: 'tcp', port: 51300 }, '2001:DB8::1')).toBe(5151);
  });

  it('UDP はポートで引き、 持ち主が 1 つに決まらなければ null', () => {
    expect(table.ownerOf({ transport: 'udp', port: 61000 }, '203.0.113.9')).toBe(7777);
    expect(table.ownerOf({ transport: 'udp', port: 5353 }, '224.0.0.251')).toBeNull();
  });

  it('表に無いポートは null', () => {
    expect(table.ownerOf({ transport: 'tcp', port: 40000 }, '203.0.113.5')).toBeNull();
  });
});
