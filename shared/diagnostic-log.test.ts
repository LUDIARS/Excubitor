import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// 出力先と抑制間隔は module 評価時に確定するため、 import より前に env を差し替える。
const dir = mkdtempSync(join(tmpdir(), 'excubitor-diag-'));
const logPath = join(dir, 'nested', 'diag.log');
process.env.EXCUBITOR_DIAG_LOG = logPath;
process.env.EXCUBITOR_DIAG_REPEAT_MS = '10000';

const { writeDiagnostic, resetDiagnosticThrottleForTests } = await import('./diagnostic-log.js');

afterAll(() => {
  delete process.env.EXCUBITOR_DIAG_LOG;
  delete process.env.EXCUBITOR_DIAG_REPEAT_MS;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetDiagnosticThrottleForTests();
});

function lines(): Record<string, unknown>[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('writeDiagnostic', () => {
  // uncaughtException のハンドラが自分自身の例外を再生産する障害では、 抑制が無いと
  // 秒間数千行を同期書き込みし続ける (2026-07-26: 25 日で 32.4 GB / CPU 87%)。
  it('同一事象の連投を 1 行に畳み込む', () => {
    for (let i = 0; i < 500; i++) {
      writeDiagnostic('uncaughtException', { err: 'Error: EBADF: bad file descriptor, write' });
    }
    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0].event).toBe('uncaughtException');
  });

  it('別事象は抑制せず即座に書く', () => {
    writeDiagnostic('uncaughtException', { err: 'Error: EBADF: bad file descriptor, write' });
    writeDiagnostic('server.listening', { port: 17332 });
    writeDiagnostic('uncaughtException', { err: 'Error: something else entirely' });

    const written = lines();
    expect(written.map((entry) => entry.event)).toEqual([
      'uncaughtException',
      'server.listening',
      'uncaughtException',
    ]);
  });

  it('畳み込んだ件数を次の書き込みに残す (黙って捨てない)', () => {
    const err = 'Error: EBADF: bad file descriptor, write';
    for (let i = 0; i < 42; i++) writeDiagnostic('uncaughtException', { err });

    // 抑制窓を跨いだ扱いにして、 同じ事象をもう一度書かせる。
    resetDiagnosticThrottleForTests();
    // reset でファイルは消えないので、 直前の 1 行 + 今回の 1 行になる。
    writeDiagnostic('uncaughtException', { err });

    const written = lines();
    expect(written).toHaveLength(2);
    expect(written[0].suppressed_repeats).toBeUndefined();
  });

  it('出力先ディレクトリが無ければ作る', () => {
    writeDiagnostic('server.starting', { port: 17332 });
    expect(lines()).toHaveLength(1);
  });
});
