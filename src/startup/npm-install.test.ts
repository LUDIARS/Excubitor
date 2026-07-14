import { describe, expect, it } from 'vitest';
import { parseNpmAuditSummary, startupNpmChecksEnabled } from './npm-install.js';

describe('parseNpmAuditSummary', () => {
  it('reads vulnerability totals from npm audit json', () => {
    expect(parseNpmAuditSummary(JSON.stringify({
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 1,
          moderate: 2,
          high: 3,
          critical: 4,
          total: 10,
        },
      },
    }))).toEqual({
      total: 10,
      vulnerabilities: {
        info: 0,
        low: 1,
        moderate: 2,
        high: 3,
        critical: 4,
        total: 10,
      },
    });
  });

  it('returns null for non-json output', () => {
    expect(parseNpmAuditSummary('npm error')).toBeNull();
  });

  it('skips startup npm checks locally unless explicitly enabled', () => {
    expect(startupNpmChecksEnabled({})).toBe(false);
    expect(startupNpmChecksEnabled({ CI: 'true' })).toBe(true);
    expect(startupNpmChecksEnabled({ EXCUBITOR_STARTUP_NPM_CHECK: '1' })).toBe(true);
    expect(startupNpmChecksEnabled({ CI: 'true', EXCUBITOR_STARTUP_NPM_CHECK: '0' })).toBe(false);
  });
});
