import { describe, it, expect } from 'vitest';
import { summarizeServices } from './router.js';

describe('summarizeServices', () => {
  it('counts running as up, unknown/null as unknown, others as down', () => {
    const rows = [
      { state: 'running' },
      { state: 'running' },
      { state: 'stopped' },
      { state: 'exited' },
      { state: 'unknown' },
      { state: null },
      {}, // state 欠落も unknown
    ];
    const s = summarizeServices(rows, 3);
    expect(s).toEqual({
      service: 'excubitor',
      services_total: 7,
      up: 2,
      down: 2,
      unknown: 3,
      open_errors: 3,
    });
  });

  it('handles empty service list', () => {
    expect(summarizeServices([], 0)).toEqual({
      service: 'excubitor',
      services_total: 0,
      up: 0,
      down: 0,
      unknown: 0,
      open_errors: 0,
    });
  });
});
