import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 実装は src/ だけでなくリポ直下の shared/ にもある (logger / diagnostic-log)。
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
    // 既定の 10s は、このホストが並行セッションで埋まっているときに足りない。
    // 実測 (2026-08-13): 全体実行だと api-routes の最初の beforeEach が 10s を超えて
    // `Hook timed out in 10000ms` になり、単体実行では同じ hook が通る。テストの欠陥では
    // なく負荷に対する予算不足なので、setup の予算だけ広げる。テスト本体の timeout は
    // 既定のままにして、本当に遅い実装を見逃さないようにする。
    hookTimeout: 30_000,
  },
});
