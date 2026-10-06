import { describe, expect, it } from 'vitest';
import type { Service } from '../../catalog/loader.js';
import { withBootstrapFallback } from './peer-operation-routes.js';

const catalog = {
  services: [
    { code: 'svc-a', name: 'A', disabled: false, repo: 'LUDIARS/Svc-A' } as Service,
    { code: 'svc-private', name: 'P', disabled: false, repo: 'someone/elsewhere' } as Service,
  ],
};
const service = (action: string, code = 'svc-a') => ({ target: { kind: 'service' as const, code }, action } as never);

describe('withBootstrapFallback (head office → other node deploy)', () => {
  it('attaches the head office catalog repo to update / deploy', () => {
    expect(withBootstrapFallback(service('deploy'), catalog)).toMatchObject({ bootstrap: { repository: 'LUDIARS/Svc-A', start: true } });
    expect(withBootstrapFallback(service('update'), catalog)).toMatchObject({ bootstrap: { repository: 'LUDIARS/Svc-A', start: false } });
  });

  it('leaves other actions, unknown services, unapproved repos and explicit options untouched', () => {
    const restart = service('restart');
    expect(withBootstrapFallback(restart, catalog)).toBe(restart);
    const unknown = service('deploy', 'nope');
    expect(withBootstrapFallback(unknown, catalog)).toBe(unknown);
    const privateRepo = service('deploy', 'svc-private');
    expect(withBootstrapFallback(privateRepo, catalog)).toBe(privateRepo);
    const explicit = { ...(service('deploy') as object), bootstrap: { repository: 'LUDIARS/Other', start: false } } as never;
    expect(withBootstrapFallback(explicit, catalog)).toBe(explicit);
    const self = { target: { kind: 'excubitor' }, action: 'deploy' } as never;
    expect(withBootstrapFallback(self, catalog)).toBe(self);
    expect(withBootstrapFallback(service('deploy'), null)).toEqual(service('deploy'));
  });
});
