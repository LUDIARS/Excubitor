import { describe, expect, it } from 'vitest';

import type { Catalog } from '../../catalog/loader.js';
import watchArgsContract from './contracts/watch-args.contract.js';
import { collectWatchHosts } from './hosts.js';
import { buildWatchArgs, resolveWatchEndpoints } from './watch-args.js';

function catalogOf(services: Array<Record<string, unknown>>): Catalog {
  return { services } as unknown as Catalog;
}

describe('resolveWatchEndpoints / buildWatchArgs', () => {
  it('builds loopback URLs from catalog ports and lists every host', () => {
    const catalog = catalogOf([
      { code: 'revisor', port: 40001 },
      { code: 'concordia', port: 40002 },
    ]);
    const endpoints = resolveWatchEndpoints(catalog, { revisor: 'revisor', concordia: 'concordia' });
    expect(endpoints).toEqual({ revisorUrl: 'http://127.0.0.1:40001', concordiaUrl: 'http://127.0.0.1:40002' });
    const input = {
      hosts: [
        { dir: '/w/a', serviceCodes: ['a'], private: false },
        { dir: '/w/b', serviceCodes: ['b'], private: true },
      ],
      stateDir: '/data/ergo-watch',
      outDir: '/data/ergo-watch/out',
      endpoints,
    };
    const args = buildWatchArgs(input);
    expect(args).toEqual([
      'watch', '--host', '/w/a', '--host', '/w/b',
      '--state', '/data/ergo-watch', '--out', '/data/ergo-watch/out',
      '--revisor-url', 'http://127.0.0.1:40001', '--concordia-url', 'http://127.0.0.1:40002',
    ]);
    expect(watchArgsContract.post(args, input)).toBe(true);
  });

  it('omits a provenance URL when the service or its port is missing', () => {
    const catalog = catalogOf([{ code: 'revisor' }, { code: 'concordia', port: 40002, disabled: true }]);
    const endpoints = resolveWatchEndpoints(catalog, { revisor: 'revisor', concordia: 'concordia' });
    expect(endpoints).toEqual({ revisorUrl: null, concordiaUrl: null });
    const input = { hosts: [], stateDir: '/s', outDir: '/s/out', endpoints };
    const args = buildWatchArgs(input);
    expect(args).not.toContain('--revisor-url');
    expect(args).not.toContain('--concordia-url');
    expect(watchArgsContract.post(args, input)).toBe(true);
  });
});

describe('collectWatchHosts', () => {
  it('folds services by checkout and keeps private when any declaration is private', () => {
    const catalog = catalogOf([
      { code: 'a', cwd: '/w/ln/native', ergo_watch: true, disabled: false },
      { code: 'b', cwd: '/w/ln', ergo_watch: { private: true }, disabled: false },
      { code: 'c', cwd: '/w/other', ergo_watch: false, disabled: false },
      { code: 'd', ergo_watch: true, disabled: false },
      { code: 'e', cwd: '/w/plain', ergo_watch: true, disabled: false },
    ]);
    const roots: Record<string, string> = { '/w/ln/native': '/w/ln', '/w/ln': '/w/ln' };
    const { hosts, issues } = collectWatchHosts(catalog, (dir) => roots[dir] ?? null);
    expect(hosts).toEqual([{ dir: '/w/ln', serviceCodes: ['a', 'b'], private: true }]);
    expect(issues.map((issue) => issue.service)).toEqual(['d', 'e']);
  });
});
