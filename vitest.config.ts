import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 実装は src/ だけでなくリポ直下の shared/ にもある (logger / diagnostic-log)。
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});
