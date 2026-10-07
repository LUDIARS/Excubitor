import { describe, expect, it } from 'vitest';
import type { Service } from '../../catalog/loader.js';
import { needsPreflight, preflightOperation, upstreamRefFor, type PreflightDeps } from './preflight.js';
import { MESH_REMOTE_REF } from './mesh-source.js';

const catalog = {
  services: [
    { code: 'svc-a', name: 'A', disabled: false, repo: 'LUDIARS/A' } as Service,
    { code: 'svc-norepo', name: 'N', disabled: false } as Service,
    { code: 'excubitor', name: 'Ex', disabled: false, repo: 'LUDIARS/Excubitor', cwd: '/ex' } as Service,
  ],
};

const readyRepo: PreflightDeps['checkRepo'] = async () => ({ ready: { repoDir: '/a', branch: 'main' }, step: null });
const cleanSelf: PreflightDeps = {
  isDirty: async () => false,
  readHead: async () => ({ branch: 'main' }),
  countAhead: async () => 0,
};

const service = (action: string, code = 'svc-a') => ({ target: { kind: 'service' as const, code }, action } as never);
const self = (action: string) => ({ target: { kind: 'excubitor' as const }, action } as never);

describe('preflightOperation', () => {
  it('only checks update and deploy', async () => {
    expect(needsPreflight(self('stash'))).toBe(false);
    expect(await preflightOperation({ request: self('stash'), source: 'origin', catalog, requesterPeerId: null }, {
      isDirty: async () => { throw new Error('stash must not require a clean checkout'); },
    })).toEqual({ ok: true });
    expect(needsPreflight(service('restart'))).toBe(false);
    expect(needsPreflight(service('reflect'))).toBe(false);
    expect(needsPreflight(service('bootstrap'))).toBe(false);
    const never: PreflightDeps = { checkRepo: async () => { throw new Error('must not run'); } };
    expect(await preflightOperation({ request: service('restart'), source: 'origin', catalog, requesterPeerId: null }, never))
      .toEqual({ ok: true });
  });

  it('accepts a clean service checkout that can fast-forward', async () => {
    const result = await preflightOperation(
      { request: service('deploy'), source: 'origin', catalog, requesterPeerId: null },
      { checkRepo: readyRepo, countAhead: async () => 0 },
    );
    expect(result).toEqual({ ok: true });
  });

  it('maps service repo readiness failures to error codes', async () => {
    const failing = (step: string): PreflightDeps => ({ checkRepo: async () => ({ ready: null, step: { step } }) });
    const run = (step: string) => preflightOperation({ request: service('update'), source: 'origin', catalog, requesterPeerId: null }, failing(step));
    expect(await run('dirty_check')).toMatchObject({ ok: false, status: 409, error: 'dirty_worktree' });
    expect(await run('branch')).toMatchObject({ ok: false, status: 409, error: 'detached_head' });
    expect(await run('repo')).toMatchObject({ ok: false, status: 409, error: 'repo_not_found' });
  });

  it('refuses when local commits are ahead of the upstream ref, and passes when the ref is unknown', async () => {
    const refs: string[] = [];
    const ahead = await preflightOperation(
      { request: service('update'), source: 'origin', catalog, requesterPeerId: null },
      { checkRepo: readyRepo, countAhead: async (_dir, ref) => { refs.push(ref); return 2; } },
    );
    expect(ahead).toMatchObject({ ok: false, status: 409, error: 'not_fast_forward' });
    expect(refs).toEqual(['origin/main']);
    const unknown = await preflightOperation(
      { request: service('update'), source: 'origin', catalog, requesterPeerId: null },
      { checkRepo: readyRepo, countAhead: async () => null },
    );
    expect(unknown).toEqual({ ok: true });
  });

  it('refuses a mesh source without a requesting peer or a catalog repo', async () => {
    const deps: PreflightDeps = { checkRepo: readyRepo, countAhead: async () => 0 };
    expect(await preflightOperation({ request: service('update'), source: 'mesh', catalog, requesterPeerId: null }, deps))
      .toMatchObject({ ok: false, status: 409, error: 'mesh_source_unavailable' });
    expect(await preflightOperation({ request: service('update', 'svc-norepo'), source: 'mesh', catalog, requesterPeerId: 'peer-1' }, deps))
      .toMatchObject({ ok: false, status: 409, error: 'mesh_source_unavailable' });
    expect(await preflightOperation({ request: service('update'), source: 'mesh', catalog, requesterPeerId: 'peer-1' }, deps))
      .toEqual({ ok: true });
  });

  it('checks the Excubitor checkout itself for self update / deploy', async () => {
    expect(await preflightOperation({ request: self('deploy'), source: 'origin', catalog, requesterPeerId: null }, cleanSelf))
      .toEqual({ ok: true });
    expect(await preflightOperation({ request: self('update'), source: 'origin', catalog, requesterPeerId: null }, { ...cleanSelf, isDirty: async () => true }))
      .toMatchObject({ ok: false, error: 'dirty_worktree' });
    expect(await preflightOperation({ request: self('update'), source: 'origin', catalog, requesterPeerId: null }, { ...cleanSelf, isDirty: async () => null }))
      .toMatchObject({ ok: false, error: 'git_status_unavailable' });
    expect(await preflightOperation({ request: self('update'), source: 'origin', catalog, requesterPeerId: null }, { ...cleanSelf, readHead: async () => ({ branch: 'HEAD' }) }))
      .toMatchObject({ ok: false, error: 'detached_head' });
    expect(await preflightOperation({ request: self('update'), source: 'origin', catalog, requesterPeerId: null }, { ...cleanSelf, countAhead: async () => 1 }))
      .toMatchObject({ ok: false, error: 'not_fast_forward' });
  });
});

describe('mesh bootstrap preflight', () => {
  const request = { target: { kind: 'service' as const, code: 'new-svc' }, action: 'bootstrap', bootstrap: { repository: 'LUDIARS/Example', start: true } } as never;
  it('refuses a local mesh bootstrap (no requesting peer to clone from) and accepts one from a peer', async () => {
    expect(await preflightOperation({ request, source: 'mesh', catalog, requesterPeerId: null }))
      .toMatchObject({ ok: false, status: 409, error: 'mesh_source_unavailable' });
    expect(await preflightOperation({ request, source: 'mesh', catalog, requesterPeerId: 'peer-1' })).toEqual({ ok: true });
    expect(await preflightOperation({ request, source: 'origin', catalog, requesterPeerId: null })).toEqual({ ok: true });
  });
});

describe('upstreamRefFor', () => {
  it('uses origin/<branch> for origin and the imported mesh ref for mesh', () => {
    expect(upstreamRefFor('origin', 'main')).toBe('origin/main');
    expect(upstreamRefFor('mesh', 'main')).toBe(MESH_REMOTE_REF);
  });
});
