import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemotePeer } from '../store.js';
import { bundleCreateArgs, createMainBundle, findRepoCheckout, isValidHash, isValidRepoName } from './bundle-server.js';
import { fastForwardFromMesh } from './mesh-source.js';

/**
 * 依頼元 (source) が作った bundle を、 外部に出られない拠点 (target) が取り込むまでを実 git で通す。
 * git の起動は環境によって 1 回数秒かかるので、 source は 1 度だけ作り、 target だけ毎回作り直す。
 */

const GIT_TEST_TIMEOUT_MS = 180_000;

let root: string;
let source: string;
let target: string;
let firstCommit: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function commit(dir: string, file: string, content: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `edit ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

const peer = { id: 'p1', name: 'origin-site' } as RemotePeer;

/** 依頼元の bundle-server をそのまま呼ぶ download (HTTP の代わり)。 */
function downloadFrom(repoDir: string) {
  return async (_peer: RemotePeer, _repo: string, have: string | null, dest: string) => {
    const bundle = await createMainBundle(repoDir, have);
    if (bundle.kind === 'up_to_date') return { ok: true, upToDate: true, status: 204, error: null };
    if (bundle.kind === 'error') return { ok: false, upToDate: false, status: bundle.status, error: bundle.error };
    copyFileSync(bundle.path, dest);
    await bundle.cleanup();
    return { ok: true, upToDate: false, status: 200, error: null };
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ex-mesh-src-'));
  source = join(root, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  firstCommit = commit(source, 'a.txt', 'one');
  commit(source, 'a.txt', 'two');
}, GIT_TEST_TIMEOUT_MS);

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('mesh update source', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  let targetSeq = 0;
  beforeEach(() => {
    targetSeq += 1;
    target = join(root, `target-${targetSeq}`);
    // 外部に出られない拠点を模して remote を外し、 最初のコミットへ戻す (--no-local で hardlink を避ける)。
    execFileSync('git', ['clone', '-q', '--no-local', source, target]);
    git(target, 'remote', 'remove', 'origin');
    git(target, 'reset', '-q', '--hard', firstCommit);
  }, GIT_TEST_TIMEOUT_MS);

  afterEach(() => {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('fast-forwards the target to the requester main through a bundle', async () => {
    const newest = commit(source, 'b.txt', 'three');
    const steps = await fastForwardFromMesh(peer, 'LUDIARS/Demo', target, 'main', { download: downloadFrom(source) });
    expect(steps.map((s) => [s.step, s.ok])).toEqual([
      ['mesh_fetch', true], ['mesh_verify', true], ['mesh_import', true], ['pull', true],
    ]);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(newest);
  });

  it('reports up to date without touching the checkout', async () => {
    const head = git(source, 'rev-parse', 'HEAD');
    git(target, 'reset', '-q', '--hard', head);
    const steps = await fastForwardFromMesh(peer, 'LUDIARS/Demo', target, 'main', { download: downloadFrom(source) });
    expect(steps).toEqual([{ step: 'mesh_fetch', ok: true, detail: 'already up to date with origin-site' }]);
  });

  it('refuses a diverged checkout instead of merging', async () => {
    commit(target, 'local.txt', 'local change');
    const steps = await fastForwardFromMesh(peer, 'LUDIARS/Demo', target, 'main', { download: downloadFrom(source) });
    expect(steps.at(-1)).toMatchObject({ step: 'pull', ok: false });
  });

  it('only updates checkouts on main', async () => {
    const steps = await fastForwardFromMesh(peer, 'LUDIARS/Demo', target, 'feature', { download: downloadFrom(source) });
    expect(steps).toEqual([expect.objectContaining({ step: 'mesh_branch', ok: false })]);
  });
});

describe('bundle server helpers', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('builds incremental or full bundle arguments', () => {
    expect(bundleCreateArgs('f', 'abc1234')).toEqual(['bundle', 'create', 'f', 'refs/heads/main', '^abc1234']);
    expect(bundleCreateArgs('f', null)).toEqual(['bundle', 'create', 'f', 'refs/heads/main']);
  });

  it('validates repo names and hashes from the query string', () => {
    expect(isValidRepoName('LUDIARS/Excubitor')).toBe(true);
    expect(isValidRepoName('../etc/passwd')).toBe(false);
    expect(isValidRepoName('a/b/c')).toBe(false);
    expect(isValidHash('0123abcd')).toBe(true);
    expect(isValidHash('HEAD~1')).toBe(false);
  });

  it('finds the checkout of a repo through the catalog', async () => {
    const catalog = { services: [{ code: 'demo', repo: 'LUDIARS/Demo', cwd: join(source) }] } as never;
    expect(await findRepoCheckout(catalog, 'ludiars/demo')).toBe(source);
    expect(await findRepoCheckout(catalog, 'LUDIARS/Other')).toBeNull();
  });

  it('sends a full bundle when it does not know the requester head', async () => {
    const bundle = await createMainBundle(source, 'ffffffffffffffffffffffffffffffffffffffff');
    expect(bundle.kind).toBe('bundle');
    if (bundle.kind === 'bundle') await bundle.cleanup();
  });
});
