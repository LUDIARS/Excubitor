import { describe, expect, it, vi } from 'vitest';
import type { RemotePeer } from '../federation/store.js';
import { meshCloner } from './mesh-clone.js';

const peer = { id: 'p1', name: 'hq', base_url: 'http://hq' } as RemotePeer;
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });

describe('meshCloner', () => {
  it('downloads the full main bundle from the requester, clones it and points origin at GitHub', async () => {
    const download = vi.fn(async () => ({ ok: true, upToDate: false, status: 200, error: null }));
    const calls: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      return args[1] === 'list-heads' ? ok('abc123 refs/heads/main\n') : ok();
    });
    await meshCloner(peer, { download, exec: exec as never })('LUDIARS/Example', '/ars/Example', '/ars');
    expect(download).toHaveBeenCalledWith(peer, 'LUDIARS/Example', null, expect.stringContaining('main.bundle'));
    expect(calls.map((a) => a.slice(0, 2).join(' '))).toEqual(['bundle list-heads', 'clone --branch', 'remote set-url']);
    expect(calls[2]).toEqual(['remote', 'set-url', 'origin', 'https://github.com/LUDIARS/Example.git']);
  });

  it('fails without cloning when the requester cannot serve the bundle or it has no main', async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[]) => ok(''));
    const failing = vi.fn(async () => ({ ok: false, upToDate: false, status: 404, error: 'repo_not_found_on_this_node' }));
    await expect(meshCloner(peer, { download: failing, exec: exec as never })('LUDIARS/Example', '/t', '/r')).rejects.toThrow(/repo_not_found/);
    const download = vi.fn(async () => ({ ok: true, upToDate: false, status: 200, error: null }));
    await expect(meshCloner(peer, { download, exec: exec as never })('LUDIARS/Example', '/t', '/r')).rejects.toThrow(/no main/);
    expect(exec.mock.calls.some((call) => call[1][0] === 'clone')).toBe(false);
  });
});
