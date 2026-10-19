import { describe, expect, it } from 'vitest';
import { validateWorkloadClaims } from './claims.js';
import { NOW, workloadClaims } from './test-fixtures.js';

const input = () => ({ claims: workloadClaims(), subject: 'branch/excubitor', audience: 'hq/excubitor', now: NOW });
describe('workload claim boundary', () => {
  it('accepts a current workload token', () => expect(validateWorkloadClaims(input()).sub).toBe('branch/excubitor'));
  it.each([
    { exp: new Date(NOW).toISOString() },
    { exp: new Date(NOW + 60_001).toISOString() },
    { iat: new Date(NOW + 1).toISOString() },
    { sub: 'excubitor' }, { kind: 'service' }, { cnf: { public_key: 'malformed' } },
    { grants: [{ action: 'ai-spawn', resource: '*' }] },
  ])('rejects malformed, project-wide or stale claims: %j', change => {
    expect(() => validateWorkloadClaims({ ...input(), claims: { ...workloadClaims(), ...change } })).toThrow();
  });
});
