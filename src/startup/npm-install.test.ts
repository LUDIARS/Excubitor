import { describe, expect, it } from 'vitest';
import { parseNpmAuditSummary } from './npm-install.js';

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
});
