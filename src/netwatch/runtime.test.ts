/** @implements SPEC-EX-NETWATCH */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Catalog } from '../catalog/loader.js';
import { startNetwatch, type NetwatchHandle } from './runtime.js';
import { NETWATCH_INTERFACE_ENV } from './settings.js';
import { TSHARK_FIELDS } from './tshark-command.js';
import type { TsharkProcessOptions } from './tshark-process.js';

function catalog(overlayFile = 'overlay.telalist'): Catalog {
  return {
    netwatch: {
      enabled: true, capture_filter: '', name_resolution: 'g', home_country: 'JP', max_destinations: 100,
      dns_ttl_sec: 600, restart_after_min: 60, retry_after_sec: 30,
      overlay: { file: overlayFile, max_rows: 12, include: 'public', interval_sec: 60 },
      detect: { owner_poll_sec: 2, allowed_ports: [53, 80, 443, 853], trusted_domains: [] as string[] },
    },
  } as Catalog;
}

class FakeProcess {
  readonly stderrTail: string[] = [];
  readonly pid = 4242;
  started = false;
  stopped = false;
  constructor(readonly options: TsharkProcessOptions) {}
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}

/** tshark の 1 行をフィールド名で組む。 */
function tsharkLine(values: Partial<Record<(typeof TSHARK_FIELDS)[number], string>>): string {
  return TSHARK_FIELDS.map((name) => values[name] ?? '').join('\t');
}

/** 接続表を読み終えるまで待つ (読み取りは非同期)。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let handle: NetwatchHandle | null = null;
let dir: string | null = null;

afterEach(() => {
  handle?.stop();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('startNetwatch', () => {
  it('設定に netwatch が無くても起動を落とさず、 通信監視だけを failed にする', () => {
    dir = mkdtempSync(join(tmpdir(), 'netwatch-'));
    handle = startNetwatch({ getCatalog: () => ({ services: [] }) as unknown as Catalog, env: {}, cwd: dir });
    const snapshot = handle.snapshot();
    expect(snapshot.status.state).toBe('failed');
    expect(snapshot.status.reason).toMatch(/^設定が不正: /);
    expect(snapshot.destinations).toEqual([]);
    expect(snapshot.homeCountry).toBeNull();
  });

  it('インタフェースの env が無い拠点では tshark を起動せず、 一覧ファイルも書かない', () => {
    dir = mkdtempSync(join(tmpdir(), 'netwatch-'));
    const created: FakeProcess[] = [];
    handle = startNetwatch({
      getCatalog: () => catalog(), env: {}, cwd: dir,
      createProcess: (options) => { const child = new FakeProcess(options); created.push(child); return child; },
    });
    expect(handle.snapshot().status).toMatchObject({ state: 'disabled', reason: `${NETWATCH_INTERFACE_ENV} 未設定` });
    expect(created).toHaveLength(0);
    expect(existsSync(join(dir, 'overlay.telalist'))).toBe(false);
  });

  it('設定が揃えば tshark を起動して行を集計し、 stop で止める', () => {
    dir = mkdtempSync(join(tmpdir(), 'netwatch-'));
    const created: FakeProcess[] = [];
    handle = startNetwatch({
      // 一覧ファイルは書かせない (stop 後の最後の書き込みが一時ディレクトリの削除と競合しないように)。
      getCatalog: () => catalog(''), env: { [NETWATCH_INTERFACE_ENV]: 'Wi-Fi' }, cwd: dir, now: () => 0,
      platform: 'win32', readConnections: async () => '',
      createProcess: (options) => { const child = new FakeProcess(options); created.push(child); return child; },
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.started).toBe(true);
    expect(created[0]?.options.args.slice(0, 2)).toEqual(['-i', 'Wi-Fi']);
    const fields = ['1.5', 'eth:ip:tcp', '192.168.1.10', '203.0.113.5', '', '', '443', '', '', '1', '0'];
    created[0]?.options.onLine(fields.join('\t'));
    created[0]?.options.onLine('not a tshark line');
    const snapshot = handle.snapshot();
    expect(snapshot.status).toMatchObject({ state: 'running', pid: 4242 });
    expect(snapshot.homeCountry).toBe('JP');
    expect(snapshot.destinations.map((destination) => destination.remote)).toEqual(['203.0.113.5']);
    expect(snapshot.unparsedLines).toBe(1);
    handle.stop();
    expect(created[0]?.stopped).toBe(true);
    handle = null;
  });

  it('接続表で送信元プロセスを特定し、 サービスの子孫の通信を一覧の既定から外す', async () => {
    dir = mkdtempSync(join(tmpdir(), 'netwatch-'));
    const created: FakeProcess[] = [];
    const netstat = [
      '  TCP    192.168.1.10:51000   203.0.113.5:443   ESTABLISHED   40',
      '  TCP    192.168.1.10:51001   203.0.113.6:8443  ESTABLISHED   30',
    ].join('\r\n');
    handle = startNetwatch({
      getCatalog: () => catalog(''), env: { [NETWATCH_INTERFACE_ENV]: 'Wi-Fi' }, cwd: dir, now: () => 0,
      platform: 'win32',
      readConnections: async () => netstat,
      listProcesses: () => [
        { pid: 20, ppid: 1, name: 'node.exe' },
        { pid: 30, ppid: 20, name: 'worker.exe' },
        { pid: 40, ppid: 1, name: 'chrome.exe' },
      ],
      listServiceRoots: () => [{ code: 'memoria', pid: 20 }],
      createProcess: (options) => { const child = new FakeProcess(options); created.push(child); return child; },
    });
    await settle();
    const syn = { 'frame.time_epoch': '1', 'tcp.flags.syn': '1', 'tcp.flags.ack': '0' };
    created[0]?.options.onLine(tsharkLine({ ...syn, 'ip.dst': '203.0.113.5', 'tcp.dstport': '443', 'tcp.srcport': '51000' }));
    created[0]?.options.onLine(tsharkLine({ ...syn, 'ip.dst': '203.0.113.6', 'tcp.dstport': '8443', 'tcp.srcport': '51001' }));
    const snapshot = handle.snapshot();
    expect(snapshot.attribution).toMatchObject({ state: 'running', attributed: 2, pending: 0 });
    const byRemote = new Map(snapshot.destinations.map((destination) => [destination.remote, destination]));
    expect(byRemote.get('203.0.113.5')).toMatchObject({
      owners: [{ pid: 40, name: 'chrome.exe', service: null }],
      assessment: { services: [], reasons: ['direct-ip'] },
    });
    expect(byRemote.get('203.0.113.6')).toMatchObject({
      owners: [{ pid: 30, name: 'worker.exe', service: 'memoria' }],
      assessment: { services: ['memoria'], reasons: [] },
    });
  });

  it('Windows 以外では送信元を特定せず、 接続表も読まない', () => {
    dir = mkdtempSync(join(tmpdir(), 'netwatch-'));
    let reads = 0;
    handle = startNetwatch({
      getCatalog: () => catalog(''), env: { [NETWATCH_INTERFACE_ENV]: 'eth0' }, cwd: dir, now: () => 0,
      platform: 'linux',
      readConnections: async () => { reads += 1; return ''; },
      createProcess: (options) => new FakeProcess(options),
    });
    expect(reads).toBe(0);
    expect(handle.snapshot().attribution).toMatchObject({ state: 'unsupported', reason: 'Windows 以外は送信元プロセスを特定しない' });
  });
});
