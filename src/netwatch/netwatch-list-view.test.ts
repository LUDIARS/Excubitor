/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import type { AttributionStatus } from './connection-poller.js';
import { netwatchListView } from './netwatch-list-view.js';
import { MAX_LIST_ROWS, TELA_LIST_MAGIC, renderListView } from './tela-list-format.js';
import type { AssessedDestination, CaptureStatus } from './types.js';

const running: CaptureStatus = {
  state: 'running', reason: null, pid: 1, startedAtMs: 0, stderrTail: [], publicObserved: 3, publicWithoutCountry: 1,
};
const attributing: AttributionStatus = { state: 'running', reason: null, lastRefreshMs: 0 };

function destination(overrides: Partial<AssessedDestination>): AssessedDestination {
  return {
    remote: '203.0.113.5', scope: 'public', country: 'US', locality: 'foreign', domains: ['x.example'],
    ports: [443], kinds: ['tls'], firstSeenMs: 0, lastSeenMs: 0, packets: 1, owners: [],
    assessment: { services: [], reasons: [] }, ...overrides,
  };
}

const chrome = { pid: 40, name: 'chrome.exe', service: null };
const formatTime = (ms: number): string => `t${ms}`;

describe('renderListView', () => {
  it('先頭行・見出し・状態・行をタブ区切りと LF で書き、 制御文字を空白にする', () => {
    const text = renderListView({
      title: 'T',
      status: 'a\tb\nc',
      rows: [{ mark: 'alert', columns: ['US', 'x.example'] }],
    });
    expect(text).toBe(`${TELA_LIST_MAGIC}\ntitle\tT\nstatus\ta b c\nrow\talert\tUS\tx.example\n`);
  });

  it('長すぎる値は 4096 バイトに切り、 行は上限で止める', () => {
    const text = renderListView({
      title: 'あ'.repeat(3000),
      status: '',
      rows: Array.from({ length: MAX_LIST_ROWS + 5 }, () => ({ mark: 'normal' as const, columns: ['a'] })),
    });
    const lines = text.trimEnd().split('\n');
    expect(Buffer.byteLength(lines[1]!.slice('title\t'.length), 'utf8')).toBeLessThanOrEqual(4096);
    expect(lines.filter((value) => value.startsWith('row\t'))).toHaveLength(MAX_LIST_ROWS);
  });
});

describe('netwatchListView', () => {
  const destinations = [
    destination({ remote: '198.51.100.1', country: 'JP', locality: 'domestic', domains: ['jp.example'], lastSeenMs: 30 }),
    destination({ remote: '203.0.113.5', lastSeenMs: 10, owners: [chrome, { pid: 41, name: null, service: null }] }),
    destination({
      remote: '2001:db8::1', country: 'DE', domains: [], ports: [], lastSeenMs: 20, owners: [{ pid: 77, name: null, service: null }],
      assessment: { services: [], reasons: ['direct-ip'] },
    }),
    destination({ remote: '192.0.2.9', country: null, locality: 'unknown', domains: [], lastSeenMs: 40 }),
    destination({ remote: '192.168.1.1', scope: 'private', country: null, locality: 'local', lastSeenMs: 50 }),
    destination({
      remote: '203.0.113.99', lastSeenMs: 60, owners: [{ pid: 20, name: 'node.exe', service: 'memoria' }],
      assessment: { services: ['memoria'], reasons: [] },
    }),
  ];

  it('サービスの通信を外し、 怪しいもの → 国外 → その他の順に、 判定とプログラムつきで並べる', () => {
    const view = netwatchListView(destinations, running, attributing, { maxRows: 10, include: 'public', formatTime });
    expect(view.rows).toEqual([
      { mark: 'alert', columns: ['IP直接', 'DE', 'pid 77', '(ドメイン不明)', '[2001:db8::1]', 't20'] },
      { mark: 'alert', columns: ['国外', 'US', 'chrome.exe +1', 'x.example', '203.0.113.5:443', 't10'] },
      { mark: 'muted', columns: ['-', '??', '?', '(ドメイン不明)', '192.0.2.9:443', 't40'] },
      { mark: 'normal', columns: ['-', 'JP', '?', 'jp.example', '198.51.100.1:443', 't30'] },
    ]);
    expect(view.status).toBe('怪しい 1 件 / 国外 2 件 (サービス 1 件を除外)');
  });

  it('foreign だけ・行数の上限', () => {
    const view = netwatchListView(destinations, running, attributing, { maxRows: 1, include: 'foreign', formatTime });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.columns[0]).toBe('IP直接');
  });

  it('GeoIP の未設定・送信元を特定できない理由・止まった理由を状態に出す', () => {
    const noCountry = { ...running, publicObserved: 4, publicWithoutCountry: 4 };
    const options = { maxRows: 5, include: 'public' as const, formatTime };
    expect(netwatchListView([], noCountry, attributing, options).status).toMatch(/GeoIP/);
    const failed: AttributionStatus = { state: 'failed', reason: '接続表 (netstat -ano) を読めなかった', lastRefreshMs: null };
    expect(netwatchListView([], running, failed, options).status).toMatch(/送信元不明 \(接続表/);
    const stopped: CaptureStatus = { ...running, state: 'backoff', reason: 'tshark が終了した' };
    expect(netwatchListView([], stopped, attributing, options).status).toBe('capture backoff: tshark が終了した');
  });
});
