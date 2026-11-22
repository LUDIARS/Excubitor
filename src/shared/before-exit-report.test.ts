import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installBeforeExitReport } from './before-exit-report.js';

describe('installBeforeExitReport (SPEC-EX-BEFORE-EXIT-ONCE)', () => {
  it('reports only the first beforeExit, so a reporter that schedules work cannot loop', () => {
    const source = new EventEmitter();
    const report = vi.fn();
    installBeforeExitReport(source, report);
    source.emit('beforeExit', 1);
    source.emit('beforeExit', 1);
    source.emit('beforeExit', 0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(1);
  });
});
