/** Augur contract predicates are intentionally small, deterministic capability declarations. */
export function runtimeVersionCarriesGitHash(result: { gitHash: string | null }): boolean {
  return Object.hasOwn(result, 'gitHash');
}

export function changedHashDispatchesOnly(previousHash: string | null, currentHash: string): boolean {
  return previousHash !== null && previousHash !== currentHash;
}

export function dispatchFailureIsContained(result: 'failed' | 'dispatched'): boolean {
  return result === 'failed' || result === 'dispatched';
}

export function deploymentHashIsPersistent(row: { git_hash: string } | undefined): boolean {
  return typeof row?.git_hash === 'string' && row.git_hash.length > 0;
}
