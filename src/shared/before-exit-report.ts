/**
 * `process.beforeExit` を 1 回だけ記録する (SPEC-EX-BEFORE-EXIT-ONCE)。
 *
 * beforeExit はイベントループが空になるたびに発火する。 ハンドラの中で pino (非同期書き込み) へ
 * 書くと、 その書き込みがループに仕事を足すので、 書き終わるとまた beforeExit が来る。 2026-11-22 に
 * 起動失敗 (`database is locked`) の後これが 3 分で約 50 万回くり返し、 診断ログが 2.4 GB に
 * 膨らんだうえ、 プロセスが終わらず supervisor の再起動も遅れた。 最初の 1 回だけ記録し、
 * 2 回目以降は何もしないのでループが空になり、 プロセスは exit へ進む。
 */

export type BeforeExitReporter = (code: number) => void;

interface BeforeExitSource {
  on(event: 'beforeExit', listener: (code: number) => void): unknown;
}

export function installBeforeExitReport(source: BeforeExitSource, report: BeforeExitReporter): void {
  let reported = false;
  source.on('beforeExit', (code) => {
    if (reported) return;
    reported = true;
    report(code);
  });
}
