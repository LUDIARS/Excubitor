import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBootstrapManifest } from './manifest.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
describe('service-specific bootstrap isolation', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'bootstrap-manifest-'));
    roots.push(root);
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts/hook.mjs'), '');
    return root;
  }
  function manifest(service: string): string {
    return JSON.stringify({ version: 1, service, setup: 'scripts/hook.mjs',
      data: { export: 'scripts/hook.mjs', import: 'scripts/hook.mjs' } });
  }
  it('preserves legacy setup while selecting another service independently', async () => {
    const root = await fixture();
    await writeFile(join(root, 'excubitor.bootstrap.json'), manifest('relay'));
    await writeFile(join(root, 'excubitor.bootstrap.broadcast.json'), manifest('broadcast'));
    expect((await readBootstrapManifest(root, 'relay')).service).toBe('relay');
    expect((await readBootstrapManifest(root, 'broadcast')).service).toBe('broadcast');
    await expect(readBootstrapManifest(root, 'other')).rejects.toThrow('identity mismatch');
  });
  it('never hides invalid or misidentified overrides behind a valid legacy manifest', async () => {
    const root = await fixture();
    await writeFile(join(root, 'excubitor.bootstrap.json'), manifest('broadcast'));
    const override = join(root, 'excubitor.bootstrap.broadcast.json');
    await writeFile(override, '{');
    await expect(readBootstrapManifest(root, 'broadcast')).rejects.toThrow();
    await writeFile(override, manifest('relay'));
    await expect(readBootstrapManifest(root, 'broadcast')).rejects.toThrow('identity mismatch');
    await rm(override);
    await mkdir(override);
    await expect(readBootstrapManifest(root, 'broadcast')).rejects.toThrow('regular file');
  });
  it('rejects filename traversal before lookup and missing lifecycle scripts before setup', async () => {
    const root = await fixture();
    for (const code of ['../relay', 'x/y', 'x\\y', '', '.']) {
      await expect(readBootstrapManifest(root, code)).rejects.toThrow('Invalid bootstrap service code');
    }
    await writeFile(join(root, 'excubitor.bootstrap.json'), manifest('relay'));
    await rm(join(root, 'scripts/hook.mjs'));
    await expect(readBootstrapManifest(root, 'relay')).rejects.toThrow();
  });
});
