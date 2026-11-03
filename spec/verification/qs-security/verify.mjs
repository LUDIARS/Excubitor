import assert from 'node:assert/strict';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:29602c8a */
import augurContract_6f8cf531 from './verify.contract.mjs'; /* augur-inject:contract-predicate:b6e77693 */

/**
 * Verify this patch update without changing parent constraints or unrelated resolutions.
 * @spec SPEC-EX-QS-SECURITY-LOCK
 */
export function verifyQsLock(before, after, release) {
  const key = 'node_modules/qs';
  const previous = before.packages[key];
  const updated = after.packages[key];
  assert.equal(previous.version, '6.16.0');
  assert.equal(updated.version, '6.16.2');
  assert.equal(release.version, updated.version);
  assert.equal(updated.resolved, 'https://registry.npmjs.org/qs/-/qs-6.16.2.tgz');
  assert.equal(updated.resolved, release.dist.tarball);
  assert.equal(updated.integrity, release.dist.integrity);
  assert.deepEqual(updated.dependencies, release.dependencies);
  assert.deepEqual(updated.engines, release.engines);
  assert.equal(updated.license, release.license);
  const parents = Object.entries(before.packages)
    .filter(([, pkg]) => pkg.dependencies?.qs)
    .map(([path, pkg]) => [path, pkg.dependencies.qs]);
  // These caret ranges both contain 6.16.2; fail if the dependency graph changes.
  assert.deepEqual(parents, [
    ['node_modules/body-parser', '^6.15.2'],
    ['node_modules/express', '^6.14.0'],
  ]);
  const expected = structuredClone(before);
  expected.packages[key] = {
    ...previous,
    version: release.version,
    resolved: release.dist.tarball,
    integrity: release.dist.integrity,
  };
  assert.deepEqual(after, expected);
  return true;
}
// @ts-expect-error augur-inject
verifyQsLock = contract(verifyQsLock, { ...augurContract_6f8cf531, contractId: 'C-28', mode: 'enforce', sample: 1, where: 'verify.mjs:4', rule: 'contract-wrap', id: '6f8cf531' }); /* augur-inject:contract-wrap:6f8cf531 */
