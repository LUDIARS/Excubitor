import { describe, expect, it } from 'vitest';
import { planRequiresSecret } from './requires-secret-plan.js';

describe('planRequiresSecret', () => {
  it('needs nothing from Infisical when the Vault has every requested key', () => {
    const plan = planRequiresSecret(
      [{ service: 'cernere', keys: ['A', 'B'] }],
      { A: '1', B: '2', C: 'unrequested' },
    );
    expect(plan).toEqual({ fromVault: { A: '1', B: '2' }, remaining: [] });
  });

  it('keeps only the keys the Vault lacks, per source service', () => {
    const plan = planRequiresSecret(
      [
        { service: 'cernere', keys: ['A', 'B'] },
        { service: 'other', keys: ['C'] },
      ],
      { A: '1' },
    );
    expect(plan).toEqual({
      fromVault: { A: '1' },
      remaining: [
        { service: 'cernere', keys: ['B'] },
        { service: 'other', keys: ['C'] },
      ],
    });
  });

  it('treats an empty required value as missing', () => {
    const plan = planRequiresSecret([{ service: 'cernere', keys: ['A'] }], { A: '' });
    expect(plan.remaining).toEqual([{ service: 'cernere', keys: ['A'] }]);
    expect(plan.fromVault).toEqual({});
  });
});
