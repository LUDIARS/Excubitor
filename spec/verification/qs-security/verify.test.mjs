import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyQsLock } from './verify.mjs';

const root = new URL('../../../', import.meta.url);
const before = JSON.parse(execFileSync('git', ['show', '444dcd0:package-lock.json'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
}));
const after = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
// Only public package metadata and its tarball are requested. No install scripts run.
const response = await fetch('https://registry.npmjs.org/qs/6.16.2');
assert.equal(response.status, 200);
const release = await response.json();
assert.equal(release.dist.tarball, 'https://registry.npmjs.org/qs/-/qs-6.16.2.tgz');
const tarball = await fetch(release.dist.tarball);
assert.equal(tarball.status, 200);
assert.equal('sha512-' + createHash('sha512').update(Buffer.from(await tarball.arrayBuffer())).digest('base64'), release.dist.integrity);
assert.equal(verifyQsLock(before, after, release), true);

for (const mutate of [
  (lock) => { lock.packages['node_modules/qs'].version = '6.16.0'; },
  (lock) => { lock.packages['node_modules/qs'].integrity = 'sha512-invalid'; },
  (lock) => { lock.packages['node_modules/express'].dependencies.qs = '^7.0.0'; },
  (lock) => { lock.packages['node_modules/express'].version = '6.0.0'; },
]) {
  const invalid = structuredClone(after);
  mutate(invalid);
  assert.throws(() => verifyQsLock(before, invalid, release));
}
console.log('qs lock verification passed (tarball SHA-512, parent ranges, unchanged graph, 4 negative cases)');
